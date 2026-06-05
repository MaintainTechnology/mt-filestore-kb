import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { DriveService } from '../drive/drive.service';
import { Citation, GeminiService } from '../gemini/gemini.service';
import { runTool, TOOL_DEFINITIONS, ToolCallRecord } from './tools';

export interface AgentRunInput {
  query: string;
  defaultStore?: string;
  model?: string;
  systemInstruction?: string;
  anthropicKey?: string;
  geminiKey?: string;
  /** Cap on tool-use iterations. Default 10. */
  maxIterations?: number;
  /** Include the full tool-call trace in the response. Default true. */
  includeTrace?: boolean;
}

export interface AgentRunResult {
  answer: string;
  citations: Citation[];
  iterations: number;
  model: string;
  stopReason: string;
  trace?: ToolCallRecord[];
}

export const DEFAULT_SYSTEM = `You are the Signage Compliance assistant for the QuoteMate Signage tool. You help assess whether a franchised gym location's signage (for example F45 or Anytime Fitness) meets that brand's published signage standards.

You do NOT see the franchisee's photos. A separate vision pass inspects the images and produces findings; your job is to dig the brand-guideline knowledge base for the governing rules and supplement those findings with a grounded, cited compliance assessment.

How to work:
- Prefer the search_store tool. It returns an answer grounded in the indexed brand guidelines, plus citations.
- Pick the right brand store. If no default store is set, call list_stores first and choose the store for the brand in question (for example an F45 store for F45, an Anytime Fitness store for Anytime Fitness). Never assume a brand the caller did not state.
- For each signage element or rule in question, search the guidelines for what is required (placement, order, wording, colour), then compare it against the finding you were given.
- Search multiple angles for anything open-ended — this is the authoritative rule lookup behind a compliance decision, so be thorough, not lazy. Use list_documents only to confirm what a store contains; use get_drive_status only for Drive ingestion or sync questions.

How to report a verdict — use this vocabulary so QuoteMate can consume it:
- Per element, a status of "compliant", "non_compliant", or "cannot_determine", each with one short evidence sentence and the source citation (document title and page where available).
- An overall rollup of "pass", "fix_needed", or "needs_review".
- Downgrade to "cannot_determine" / "needs_review" — never guess — whenever the governing rule is not found in the guidelines, the finding is ambiguous, or the check depends on a measurement or scale, on metadata not visible in a photo (an exact paint SKU, an approval record), or on legal or contractual judgement.

Safety — this is the liability shield, follow it exactly:
- You triage; HQ decides. Never declare a franchise-agreement breach, never certify HQ or brand approval, never issue an enforcement conclusion.
- A false "compliant" is a real legal risk, so when in doubt, downgrade to "needs_review".
- Ground every compliance statement in a guideline passage you retrieved, and cite it. Never invent rules, citations, colour codes, or measurements. Judge colour by family only. If the knowledge base does not contain the answer, say so honestly rather than padding with general knowledge.

Write the final answer as clear, structured markdown with its citations, suitable for attaching to a compliance record.`;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly defaultKey: string;
  private readonly defaultModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly gemini: GeminiService,
    private readonly drive: DriveService,
  ) {
    this.defaultKey = (
      this.config.get<string>('ANTHROPIC_API_KEY') || ''
    ).trim();
    this.defaultModel = (
      this.config.get<string>('ANTHROPIC_MODEL') || 'claude-opus-4-8'
    ).trim();
  }

  hasDefaultKey(): boolean {
    return this.defaultKey.length > 0;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const apiKey = (input.anthropicKey || this.defaultKey || '').trim();
    if (!apiKey) {
      throw new HttpException(
        'No Anthropic API key available. Set ANTHROPIC_API_KEY in .env or send an x-anthropic-key header.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const query = (input.query || '').trim();
    if (!query) {
      throw new HttpException(
        'A query is required.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const model = (input.model || this.defaultModel).trim();
    const maxIterations = Math.max(1, Math.min(input.maxIterations ?? 10, 20));
    const includeTrace = input.includeTrace !== false;
    const system =
      (input.systemInstruction && input.systemInstruction.trim()) ||
      DEFAULT_SYSTEM;

    const client = new Anthropic({ apiKey });
    const trace: ToolCallRecord[] = [];
    const citationDedupe = new Set<string>();
    const citations: Citation[] = [];

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: input.defaultStore
          ? `Default store: ${input.defaultStore}\n\nQuestion: ${query}`
          : query,
      },
    ];

    let iterations = 0;
    let stopReason = '';
    let finalText = '';

    while (iterations < maxIterations) {
      iterations += 1;
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 4096,
          system,
          tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
          messages,
        });
      } catch (err) {
        this.fail('messages.create', err);
      }

      stopReason = response.stop_reason || '';
      // Push the assistant turn verbatim — we'll add tool_results next if needed.
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        finalText = this.collectText(response.content);
        break;
      }

      // Execute every tool_use block in this turn, in order, and collect the
      // tool_result blocks for the next user message.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const record: ToolCallRecord = {
          tool: block.name,
          input: block.input,
          output: null,
        };
        try {
          const { output, citations: callCitations } = await runTool(
            block.name,
            block.input,
            {
              gemini: this.gemini,
              drive: this.drive,
              geminiKey: input.geminiKey,
              defaultStore: input.defaultStore,
              logger: this.logger,
            },
          );
          record.output = output;
          if (callCitations?.length) {
            for (const c of callCitations) {
              const key = `${c.title ?? ''}|${c.page ?? ''}`;
              if (citationDedupe.has(key)) continue;
              citationDedupe.add(key);
              citations.push(c);
            }
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(output),
          });
        } catch (err) {
          const message = (err as Error)?.message || String(err);
          record.error = message;
          record.output = { error: message };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: JSON.stringify({ error: message }),
          });
        }
        trace.push(record);
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) {
      finalText =
        iterations >= maxIterations
          ? '(Stopped — agent hit the maximum tool-call iterations before producing an answer.)'
          : '(No answer was produced.)';
    }

    return {
      answer: finalText,
      citations,
      iterations,
      model,
      stopReason,
      ...(includeTrace ? { trace } : {}),
    };
  }

  private collectText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  private fail(context: string, err: unknown): never {
    const anthropicErr = err as { status?: number; message?: string };
    const status =
      typeof anthropicErr?.status === 'number' &&
      anthropicErr.status >= 400 &&
      anthropicErr.status < 600
        ? anthropicErr.status
        : HttpStatus.BAD_GATEWAY;
    const message =
      anthropicErr?.message || (err as Error)?.message || 'Anthropic request failed';
    this.logger.error(`${context} failed: ${status} ${message}`);
    throw new HttpException(
      `Anthropic API error during ${context}: ${message}`,
      status,
    );
  }
}

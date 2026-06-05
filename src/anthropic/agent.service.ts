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

const DEFAULT_SYSTEM = `You are the Maintain Technology Knowledge Base research agent.

Your job is to answer the user's question using the File Search tools you have been given. Behaviour rules:
- Prefer the search_store tool. It returns a synthesised answer grounded in the indexed documents, plus citations.
- When the user has not specified a store and no default store is set, call list_stores first to discover what is available, then pick the most relevant store and search it.
- For complex or open-ended questions, call search_store multiple times with different angles (sub-questions, alternative phrasings, follow-up details). This is "deep research" — be thorough, not lazy.
- If a search returns nothing useful from one store, consider searching a different store rather than giving up.
- Use list_documents only when you genuinely need to see what is in a store (e.g. to pick the right one, or to confirm a specific document exists).
- Use get_drive_status only if the user is asking about Drive ingestion or sync setup.
- Always cite your sources in the final answer. Refer to them by document title and page where available. Do not invent citations.
- If the documents do not contain the answer, say so honestly. Do not pad with general knowledge.
- Keep the final answer focused, well-structured, and in plain English. Use markdown lists or short paragraphs as appropriate.`;

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

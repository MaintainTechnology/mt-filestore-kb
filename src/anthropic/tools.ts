import { Logger } from '@nestjs/common';
import { DriveService } from '../drive/drive.service';
import { GeminiService, SearchResult } from '../gemini/gemini.service';

/**
 * Tool definitions handed to Claude, plus the dispatcher that executes them
 * against the underlying NestJS services. The schemas follow Anthropic's
 * `input_schema` (JSON Schema, restricted).
 *
 * One source of truth: changing a tool here is enough — the agent loop in
 * agent.service.ts picks up the new shape automatically.
 */

export interface ToolContext {
  gemini: GeminiService;
  drive: DriveService;
  geminiKey?: string;
  /** Default store id/name to fall back to when Claude omits it. */
  defaultStore?: string;
  logger: Logger;
}

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  output: unknown;
  error?: string;
}

export const TOOL_DEFINITIONS = [
  {
    name: 'list_stores',
    description:
      'List every File Search store available on this project. Use this when the user has not specified a store and you need to discover what knowledge bases exist before searching.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_documents',
    description:
      'List the documents indexed inside a specific store. Useful for understanding what is available before searching, or to verify a document exists. Pass either the bare store id or the full "fileSearchStores/..." name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        store_id: {
          type: 'string',
          description: 'Store id or full fileSearchStores/... name.',
        },
      },
      required: ['store_id'],
    },
  },
  {
    name: 'search_store',
    description:
      'Ask a natural-language question grounded in the documents inside a File Search store. Returns a synthesised answer with citations (title + page + snippet). Prefer focused, specific queries over broad ones — call this multiple times with different angles for deep research. Pass either the bare store id or the full "fileSearchStores/..." name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        store_id: {
          type: 'string',
          description:
            'Store id or full fileSearchStores/... name. If omitted, the default store provided by the caller is used.',
        },
        query: {
          type: 'string',
          description: 'The question to ask, phrased clearly and specifically.',
        },
        metadata_filter: {
          type: 'string',
          description:
            'Optional metadata filter, e.g. author="Dr Deepti". Leave empty unless you have a concrete reason to scope results.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_drive_status',
    description:
      'Check whether Google Drive ingestion is wired up on this server. Returns whether Drive is configured and the service account email that needs to be shared on a folder before it can be synced.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

/** Executes a tool call from Claude and returns whatever should be passed back. */
export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<{ output: unknown; citations?: SearchResult['citations'] }> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<
    string,
    unknown
  >;

  switch (name) {
    case 'list_stores': {
      const stores = await ctx.gemini.listStores(ctx.geminiKey);
      return {
        output: {
          count: stores.length,
          stores: stores.map((s) => ({
            name: s.name,
            displayName: s.displayName,
            activeDocuments: s.activeDocumentsCount,
            createTime: s.createTime,
          })),
        },
      };
    }

    case 'list_documents': {
      const storeId = pickStore(input, ctx);
      const documents = await ctx.gemini.listDocuments(storeId, ctx.geminiKey);
      return {
        output: {
          store: ctx.gemini.normalizeStoreName(storeId),
          count: documents.length,
          documents,
        },
      };
    }

    case 'search_store': {
      const storeId = pickStore(input, ctx);
      const query = String(input.query ?? '').trim();
      if (!query) {
        return { output: { error: 'query is required' } };
      }
      const metadataFilter =
        typeof input.metadata_filter === 'string'
          ? input.metadata_filter.trim() || undefined
          : undefined;
      const result = await ctx.gemini.search(
        storeId,
        query,
        undefined,
        metadataFilter,
        ctx.geminiKey,
      );
      return {
        output: {
          store: result.store,
          model: result.model,
          answer: result.answer,
          citations: result.citations,
        },
        citations: result.citations,
      };
    }

    case 'get_drive_status': {
      const configured = ctx.drive.isConfigured();
      return {
        output: {
          configured,
          serviceAccountEmail: ctx.drive.serviceAccountEmail,
          message: configured
            ? 'Drive is connected. Folders shared with the service account email can be synced.'
            : ctx.drive.configurationError ||
              'Drive is not configured on this server.',
        },
      };
    }

    default:
      return {
        output: {
          error: `Unknown tool "${name}". Available tools: ${TOOL_DEFINITIONS.map(
            (t) => t.name,
          ).join(', ')}.`,
        },
      };
  }
}

function pickStore(
  input: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const explicit =
    (typeof input.store_id === 'string' && input.store_id.trim()) ||
    (typeof (input as any).storeId === 'string' && (input as any).storeId.trim());
  if (explicit) return explicit;
  if (ctx.defaultStore) return ctx.defaultStore;
  throw new Error(
    'No store specified. Pass store_id, or set a default store on the request.',
  );
}

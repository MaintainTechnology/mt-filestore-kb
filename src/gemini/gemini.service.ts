import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';

export interface StoreSummary {
  name: string;
  displayName?: string;
  createTime?: string;
  activeDocumentsCount?: number;
}

export interface Citation {
  title?: string;
  page?: number;
  snippet?: string;
}

export interface SearchResult {
  store: string;
  model: string;
  answer: string;
  citations: Citation[];
}

export interface UploadInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}

/**
 * System instruction handed to Gemini on every File Search query. It tells the
 * model what this knowledge base is for — retrieving brand signage standards for
 * franchised gyms (e.g. F45, Anytime Fitness) so the QuoteMate Signage tool can
 * assess whether a location's signage is compliant. Gemini is the *retriever*
 * here, not the adjudicator: it grounds answers in the indexed guideline
 * documents and cites them; it never declares a location pass/fail.
 */
export const SIGNAGE_SEARCH_SYSTEM = `You are the signage-compliance reference engine for the QuoteMate Signage tool. The documents indexed in this File Search store are the official brand signage standards and guideline manuals for franchised gyms (for example F45 and Anytime Fitness).

Your function is retrieval and grounding, not adjudication:
- Answer ONLY from the indexed brand-guideline documents. Treat them as the single source of truth for what compliant signage must look like.
- When asked about a signage element — wall logo, painted V design, workout-wall band order, storefront and door decals, window copyline / QR, reception desk signage, retail racks, paint colour, etc. — return the exact requirement the guideline states: whether it is required, its placement, order, wording, and colour, quoting the document's language where you can.
- Attribute every statement to its source document and page, so the answer can be cited in a compliance record.
- If the indexed guidelines do not cover the element asked about, say so plainly (e.g. "The indexed guidelines do not specify ..."). Never invent a rule, measurement, colour code, or page reference, and never fill gaps with general branding knowledge.
- Report colour at the family level as the documents describe it (e.g. "dark grey", "F45 red"); do not assert an exact paint SKU unless the document prints one.
- Do not declare a specific location a pass or a fail, a franchise-agreement breach, or HQ approval — you supply the governing rule; a downstream reviewer makes the verdict.

Be precise and faithful to the source: this output feeds an automated compliance assessment, so accuracy and citations matter more than fluency.`;

/**
 * Thin wrapper around the Gemini File Search REST API.
 * Docs: https://ai.google.dev/gemini-api/docs/file-search
 *
 * The File Search workflow is three steps:
 *   1. Create a File Search store (a managed vector store).
 *   2. Upload files into it — Gemini chunks, embeds and indexes them.
 *   3. Query with generateContent + the file_search tool.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly baseUrl: string;
  private readonly defaultKey: string;
  private readonly defaultModel: string;
  private readonly embeddingModel: string;
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('GEMINI_API_BASE') ||
      'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
    this.defaultKey = (this.config.get<string>('GEMINI_API_KEY') || '').trim();
    this.defaultModel = (
      this.config.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash'
    ).trim();
    this.embeddingModel = (
      this.config.get<string>('GEMINI_EMBEDDING_MODEL') || ''
    ).trim();
    this.http = axios.create({ timeout: 300000 });
  }

  hasDefaultKey(): boolean {
    return this.defaultKey.length > 0;
  }

  /** Accepts a bare id or a full `fileSearchStores/...` name; returns the full name. */
  normalizeStoreName(idOrName: string): string {
    const value = (idOrName || '').trim();
    if (!value) {
      throw new HttpException(
        'A store id or name is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return value.startsWith('fileSearchStores/')
      ? value
      : `fileSearchStores/${value}`;
  }

  private resolveKey(override?: string): string {
    const key = (override || this.defaultKey || '').trim();
    if (!key) {
      throw new HttpException(
        'No Gemini API key available. Set GEMINI_API_KEY in .env or send an x-gemini-key header.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return key;
  }

  /** Google media uploads sometimes live under an `/upload` path prefix. */
  private uploadBaseUrl(): string {
    try {
      const u = new URL(this.baseUrl);
      return `${u.protocol}//${u.host}/upload${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return this.baseUrl;
    }
  }

  private fail(context: string, err: unknown): never {
    const axErr = err as AxiosError;
    if (axErr && axErr.isAxiosError) {
      const status = axErr.response?.status;
      const data = axErr.response?.data as
        | { error?: { message?: string } }
        | undefined;
      const message =
        data?.error?.message || axErr.message || 'Gemini request failed';
      this.logger.error(`${context} failed: ${status ?? ''} ${message}`);
      const httpStatus =
        status && status >= 400 && status < 600
          ? status
          : HttpStatus.BAD_GATEWAY;
      throw new HttpException(
        `Gemini API error during ${context}: ${message}`,
        httpStatus,
      );
    }
    const message = (err as Error)?.message || String(err);
    this.logger.error(`${context} failed: ${message}`);
    throw new HttpException(
      `Gemini API error during ${context}: ${message}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Milliseconds to wait before retrying, read from Google's RetryInfo detail
   * on a 429 (e.g. retryDelay: "13s"). Returns undefined when not present.
   */
  private parseRetryDelayMs(err: AxiosError): number | undefined {
    const data = err?.response?.data as
      | { error?: { details?: Array<Record<string, unknown>> } }
      | undefined;
    for (const d of data?.error?.details ?? []) {
      if (
        String(d['@type'] ?? '').includes('RetryInfo') &&
        typeof d.retryDelay === 'string'
      ) {
        const m = d.retryDelay.match(/([\d.]+)s/);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
    return undefined;
  }

  /** Awaitable sleep. Isolated so tests can stub it out. */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * POST that retries on 429 RESOURCE_EXHAUSTED (free-tier rate limit),
   * honouring Google's suggested retryDelay (capped at 20s). All other errors
   * propagate unchanged to `fail()`. A 429 that survives the retries still
   * surfaces as a 429 so the caller learns the quota is genuinely exhausted.
   */
  private async postWithRetry(
    url: string,
    body: unknown,
    config: Record<string, unknown>,
    maxRetries = 2,
  ): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.http.post(url, body, config);
      } catch (err) {
        const ax = err as AxiosError;
        if (ax?.response?.status === 429 && attempt < maxRetries) {
          const backoff = Math.min(
            this.parseRetryDelayMs(ax) ?? 2000 * (attempt + 1),
            20000,
          );
          this.logger.warn(
            `Gemini 429 rate limit — retry ${attempt + 1}/${maxRetries} in ${backoff}ms.`,
          );
          await this.delay(backoff);
          continue;
        }
        throw err;
      }
    }
  }

  // ----- Stores -------------------------------------------------------------

  async createStore(
    displayName: string,
    embeddingModel?: string,
    apiKey?: string,
  ): Promise<StoreSummary> {
    const key = this.resolveKey(apiKey);
    const body: Record<string, unknown> = {};
    if (displayName) body.display_name = displayName;
    const embed = (embeddingModel ?? this.embeddingModel ?? '').trim();
    if (embed) body.embedding_model = embed;
    try {
      const res = await this.http.post(
        `${this.baseUrl}/fileSearchStores`,
        body,
        { params: { key } },
      );
      let data = res.data;
      if (
        data?.done !== undefined ||
        (typeof data?.name === 'string' && data.name.includes('/operations/'))
      ) {
        data = await this.pollOperation(data, key);
      }
      return this.toStoreSummary(data);
    } catch (err) {
      this.fail('createStore', err);
    }
  }

  async listStores(apiKey?: string): Promise<StoreSummary[]> {
    const key = this.resolveKey(apiKey);
    const stores: StoreSummary[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const res = await this.http.get(`${this.baseUrl}/fileSearchStores`, {
          // Gemini caps ListFileSearchStores.page_size at 20.
          params: { key, pageSize: 20, pageToken },
        });
        for (const s of res.data?.fileSearchStores || []) {
          stores.push(this.toStoreSummary(s));
        }
        pageToken = res.data?.nextPageToken;
      } while (pageToken);
      return stores;
    } catch (err) {
      this.fail('listStores', err);
    }
  }

  async getStore(idOrName: string, apiKey?: string): Promise<StoreSummary> {
    const key = this.resolveKey(apiKey);
    const name = this.normalizeStoreName(idOrName);
    try {
      const res = await this.http.get(`${this.baseUrl}/${name}`, {
        params: { key },
      });
      return this.toStoreSummary(res.data);
    } catch (err) {
      this.fail('getStore', err);
    }
  }

  async deleteStore(
    idOrName: string,
    force: boolean,
    apiKey?: string,
  ): Promise<void> {
    const key = this.resolveKey(apiKey);
    const name = this.normalizeStoreName(idOrName);
    try {
      await this.http.delete(`${this.baseUrl}/${name}`, {
        params: { key, force },
      });
    } catch (err) {
      this.fail('deleteStore', err);
    }
  }

  async listDocuments(idOrName: string, apiKey?: string): Promise<unknown[]> {
    const key = this.resolveKey(apiKey);
    const name = this.normalizeStoreName(idOrName);
    const documents: unknown[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const res = await this.http.get(`${this.baseUrl}/${name}/documents`, {
          // Gemini caps ListDocuments.page_size at 20 — every list call is a
          // round trip, so a large store can take ~1s per ~20 docs.
          params: { key, pageSize: 20, pageToken },
        });
        for (const d of res.data?.documents || []) {
          documents.push(this.summarizeDocument(d));
        }
        pageToken = res.data?.nextPageToken;
      } while (pageToken);
      return documents;
    } catch (err) {
      this.fail('listDocuments', err);
    }
  }

  // ----- Upload -------------------------------------------------------------

  /**
   * Uploads one file straight into a File Search store, then waits for Gemini
   * to chunk, embed and index it.
   *
   * Google does NOT accept a plain multipart form here — it uses a two-step
   * resumable upload protocol:
   *   1. POST `:uploadToFileSearchStore` with `X-Goog-Upload-Command: start`.
   *      The real upload URL comes back in the `x-goog-upload-url` header.
   *   2. POST the raw bytes to that URL with `X-Goog-Upload-Command:
   *      upload, finalize`.
   * Step 2 returns a long-running operation, which we then poll to completion.
   */
  async uploadFile(
    idOrName: string,
    file: UploadInput,
    displayName?: string,
    apiKey?: string,
  ): Promise<unknown> {
    const key = this.resolveKey(apiKey);
    const name = this.normalizeStoreName(idOrName);
    const numBytes = file.buffer.length;
    const mimeType = file.mimeType || 'application/octet-stream';

    let operation: unknown;
    try {
      // Step 1 — open a resumable upload session.
      const start = await this.http.post(
        `${this.uploadBaseUrl()}/${name}:uploadToFileSearchStore`,
        { display_name: displayName || file.filename },
        {
          params: { key },
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(numBytes),
            'X-Goog-Upload-Header-Content-Type': mimeType,
          },
        },
      );
      const uploadUrl = start.headers['x-goog-upload-url'] as
        | string
        | undefined;
      if (!uploadUrl) {
        throw new HttpException(
          'Gemini did not return an upload URL (missing x-goog-upload-url header).',
          HttpStatus.BAD_GATEWAY,
        );
      }

      // Step 2 — send the bytes and finalize; the response is an operation.
      const finalize = await this.http.post(uploadUrl, file.buffer, {
        headers: {
          'Content-Length': String(numBytes),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      operation = finalize.data;
    } catch (err) {
      this.fail('uploadFile', err);
    }
    const result = await this.pollOperation(operation, key);
    return this.summarizeDocument(result);
  }

  /** Polls a long-running operation until it is done, then returns its result. */
  private async pollOperation(operation: any, key: string): Promise<any> {
    let op = operation;
    let attempts = 0;
    // Only loop while `op` is genuinely a long-running operation — never spin
    // on a plain Store/Document resource that happens to carry a `name`.
    while (
      op &&
      typeof op.name === 'string' &&
      op.name.includes('operations/') &&
      op.done !== true
    ) {
      if (attempts++ > 150) {
        throw new HttpException(
          'Timed out waiting for the Gemini operation to finish.',
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const res = await this.http.get(`${this.baseUrl}/${op.name}`, {
          params: { key },
        });
        op = res.data;
      } catch (err) {
        this.fail('pollOperation', err);
      }
    }
    if (op?.error) {
      throw new HttpException(
        `Gemini operation failed: ${op.error.message || JSON.stringify(op.error)}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return op?.response ?? op;
  }

  // ----- Search -------------------------------------------------------------

  async search(
    idOrName: string,
    query: string,
    model?: string,
    metadataFilter?: string,
    apiKey?: string,
  ): Promise<SearchResult> {
    const key = this.resolveKey(apiKey);
    const name = this.normalizeStoreName(idOrName);
    const useModel = (model || this.defaultModel).trim();
    const fileSearch: Record<string, unknown> = {
      file_search_store_names: [name],
    };
    if (metadataFilter && metadataFilter.trim()) {
      fileSearch.metadata_filter = metadataFilter.trim();
    }
    const body = {
      system_instruction: { parts: [{ text: SIGNAGE_SEARCH_SYSTEM }] },
      contents: [{ parts: [{ text: query }] }],
      tools: [{ file_search: fileSearch }],
    };
    try {
      const res = await this.postWithRetry(
        `${this.baseUrl}/models/${useModel}:generateContent`,
        body,
        { params: { key } },
      );
      return this.parseSearchResponse(res.data, name, useModel);
    } catch (err) {
      this.fail('search', err);
    }
  }

  private parseSearchResponse(
    data: any,
    store: string,
    model: string,
  ): SearchResult {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const answer = parts
      .map((p: any) => p?.text || '')
      .join('')
      .trim();
    const grounding =
      candidate?.groundingMetadata || candidate?.grounding_metadata;
    const chunks =
      grounding?.groundingChunks || grounding?.grounding_chunks || [];
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const ctx = chunk?.retrievedContext || chunk?.retrieved_context;
      if (!ctx) continue;
      const title = ctx.title || ctx.uri || 'Untitled source';
      const page = ctx.pageNumber ?? ctx.page_number;
      const dedupeKey = `${title}|${page ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const snippet = String(ctx.text || '').slice(0, 320);
      citations.push({
        title,
        page: typeof page === 'number' ? page : undefined,
        snippet: snippet || undefined,
      });
    }
    return {
      store,
      model,
      answer:
        answer ||
        '(No answer was returned — the model may not have found relevant content in this store.)',
      citations,
    };
  }

  private toStoreSummary(s: any): StoreSummary {
    return {
      name: s?.name,
      displayName: s?.displayName ?? s?.display_name,
      createTime: s?.createTime ?? s?.create_time,
      activeDocumentsCount: s?.activeDocumentsCount ?? s?.active_documents_count,
    };
  }

  private summarizeDocument(doc: any): unknown {
    if (!doc || typeof doc !== 'object') return doc;
    return {
      name: doc.name,
      displayName: doc.displayName ?? doc.display_name,
      sizeBytes: doc.sizeBytes ?? doc.size_bytes,
      state: doc.state,
      createTime: doc.createTime ?? doc.create_time,
      mimeType: doc.mimeType ?? doc.mime_type,
    };
  }
}

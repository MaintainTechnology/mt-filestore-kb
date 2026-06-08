import { GeminiService, SIGNAGE_SEARCH_SYSTEM } from './gemini.service';

// A ConfigService stub whose get() always returns undefined, so the service
// falls back to its built-in defaults (base URL, model). No network is made —
// the http client is replaced with a mock before search() runs.
const fakeConfig = { get: () => undefined } as unknown as ConstructorParameters<
  typeof GeminiService
>[0];

describe('SIGNAGE_SEARCH_SYSTEM', () => {
  it('frames Gemini as a grounded brand-guideline retriever, not the adjudicator', () => {
    expect(SIGNAGE_SEARCH_SYSTEM).toContain(
      'signage-compliance reference engine',
    );
    expect(SIGNAGE_SEARCH_SYSTEM).toMatch(/retrieval and grounding, not adjudication/i);
    expect(SIGNAGE_SEARCH_SYSTEM).toContain('Answer ONLY from the indexed');
  });

  it('keeps both franchise brands in scope', () => {
    expect(SIGNAGE_SEARCH_SYSTEM).toMatch(/F45/);
    expect(SIGNAGE_SEARCH_SYSTEM).toMatch(/Anytime Fitness/);
  });

  it('forbids invention and exact paint codes, and defers the verdict', () => {
    expect(SIGNAGE_SEARCH_SYSTEM).toMatch(/Never invent/i);
    expect(SIGNAGE_SEARCH_SYSTEM).toMatch(/paint SKU/);
    expect(SIGNAGE_SEARCH_SYSTEM).toMatch(/downstream reviewer makes the verdict/i);
  });
});

describe('GeminiService.search', () => {
  it('sends SIGNAGE_SEARCH_SYSTEM as the system_instruction alongside the query', async () => {
    const service = new GeminiService(fakeConfig);
    const post = jest.fn().mockResolvedValue({ data: {} });
    // Replace the internal axios instance so no real HTTP call is made.
    (service as unknown as { http: { post: jest.Mock } }).http = { post };

    await service.search(
      'fileSearchStores/mtf45protocols-xyz',
      'Is the internal wall logo required?',
      undefined,
      undefined,
      'test-key',
    );

    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0][1] as {
      system_instruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
    };
    expect(body.system_instruction.parts[0].text).toBe(SIGNAGE_SEARCH_SYSTEM);
    expect(body.contents[0].parts[0].text).toBe(
      'Is the internal wall logo required?',
    );
  });

  it('retries once on a 429 rate limit, then succeeds', async () => {
    const service = new GeminiService(fakeConfig);
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: {
        status: 429,
        data: {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: '0s',
              },
            ],
          },
        },
      },
    });
    const post = jest
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({ data: {} });
    const svc = service as unknown as {
      http: { post: jest.Mock };
      delay: () => Promise<void>;
    };
    svc.http = { post };
    svc.delay = () => Promise.resolve(); // don't actually wait in tests

    const result = await service.search(
      'fileSearchStores/x',
      'q',
      undefined,
      undefined,
      'test-key',
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.store).toBe('fileSearchStores/x');
  });

  it('gives up after exhausting retries and lets the 429 surface as a 429', async () => {
    const service = new GeminiService(fakeConfig);
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } },
    });
    const post = jest.fn().mockRejectedValue(rateLimited);
    const svc = service as unknown as {
      http: { post: jest.Mock };
      delay: () => Promise<void>;
    };
    svc.http = { post };
    svc.delay = () => Promise.resolve();

    let caught: { getStatus?: () => number } | undefined;
    try {
      await service.search('fileSearchStores/x', 'q', undefined, undefined, 'test-key');
    } catch (e) {
      caught = e as { getStatus?: () => number };
    }
    expect(caught?.getStatus?.()).toBe(429);
    // initial attempt + 2 retries
    expect(post).toHaveBeenCalledTimes(3);
  });
});

describe('GeminiService.deleteDocument', () => {
  it('DELETEs the full document resource name with the api key', async () => {
    const service = new GeminiService(fakeConfig);
    const del = jest.fn().mockResolvedValue({ data: {} });
    (service as unknown as { http: { delete: jest.Mock } }).http = { delete: del };

    await service.deleteDocument(
      'fileSearchStores/abc/documents/xyz',
      'test-key',
    );

    expect(del).toHaveBeenCalledTimes(1);
    const [url, cfg] = del.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/fileSearchStores/abc/documents/xyz',
    );
    expect((cfg as { params: { key: string } }).params.key).toBe('test-key');
  });

  it('rejects a name that is not a document resource (400)', async () => {
    const service = new GeminiService(fakeConfig);
    (service as unknown as { http: { delete: jest.Mock } }).http = {
      delete: jest.fn(),
    };
    let status: number | undefined;
    try {
      await service.deleteDocument('fileSearchStores/abc', 'k');
    } catch (e) {
      status = (e as { getStatus?: () => number }).getStatus?.();
    }
    expect(status).toBe(400);
  });

  it('surfaces an upstream delete failure through fail()', async () => {
    const service = new GeminiService(fakeConfig);
    const upstream = Object.assign(new Error('Not Found'), {
      isAxiosError: true,
      response: { status: 404, data: { error: { message: 'doc gone' } } },
    });
    const del = jest.fn().mockRejectedValue(upstream);
    (service as unknown as { http: { delete: jest.Mock } }).http = { delete: del };
    let status: number | undefined;
    try {
      await service.deleteDocument('fileSearchStores/abc/documents/xyz', 'k');
    } catch (e) {
      status = (e as { getStatus?: () => number }).getStatus?.();
    }
    expect(status).toBe(404);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateCompactionSummary } from '@/lib/ai';
import { createProvider } from '@/lib/provider-runtime';
import {
  PROVIDER_TYPES,
  canFetchModels,
  normalizeProviderType,
  providerBaseUrlPlaceholder,
  resolveBaseUrl,
  resolveModelListRequest,
  resolveModelsUrl,
} from '@/lib/provider-type';
import { parseModelList } from '@/lib/provider-models';
import type { ChatMessage, ModelConfig, ProviderConfig } from '@/types';

/**
 * Gemini is the one protocol here that is neither OpenAI-shaped nor Anthropic's:
 * the key travels in `x-goog-api-key` instead of `Authorization`, the base URL
 * carries the API version because the SDK appends `/models/{id}:…` to it, and the
 * model list is a `{ models: [...] }` envelope whose entries are named
 * `models/<id>`. Each of those is a silent failure if assumed away — a Bearer
 * model-list fetch returns 401, a version-less base 404s, and an unstripped
 * `models/` prefix produces a model id the request cannot use — so all three are
 * pinned here. The SDK-config assertions are white-box for the same reason the
 * OpenCode and Magpie suites are: the alternative is a real network call, and the
 * wire shape is exactly what is being checked.
 */

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'Gemini',
    type: 'google',
    apiKey: 'g-key',
    models: [],
    ...overrides,
  };
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm1',
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    isVision: true,
    ...overrides,
  };
}

/** A field of the SDK model's internal config — white-box, as in the sibling suites. */
function sdkConfig(resolved: ReturnType<typeof createProvider>): Record<string, unknown> {
  return (resolved.model as unknown as { config: Record<string, unknown> }).config;
}

/** Request headers the SDK model will actually send, per its own config. */
function requestHeaders(resolved: ReturnType<typeof createProvider>): Record<string, string> {
  const headers = sdkConfig(resolved).headers;
  if (typeof headers === 'function') return headers() as Record<string, string>;
  return (headers as Record<string, string>) ?? {};
}

describe('google as a provider type', () => {
  it('is offered in the picker and survives a stored read', () => {
    expect(PROVIDER_TYPES).toContain('google');
    expect(normalizeProviderType('google')).toBe('google');
  });

  it('hints the versioned endpoint, since the SDK appends the model path to it', () => {
    // `https://generativelanguage.googleapis.com` alone would produce
    // `/models/{id}:streamGenerateContent` without the `v1beta` segment.
    expect(providerBaseUrlPlaceholder(undefined, 'google')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(providerBaseUrlPlaceholder('custom', 'google')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
  });
});

describe('createProvider on Google', () => {
  it('leaves the base URL to the SDK when none is configured', () => {
    expect(resolveBaseUrl(provider())).toBeUndefined();
    expect(sdkConfig(createProvider(provider(), model())).baseURL).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
  });

  it('lets a typed base URL win, so a proxy or gateway can be pointed at', () => {
    const proxied = provider({ baseUrl: 'https://gemini-gw.internal/v1beta' });
    expect(sdkConfig(createProvider(proxied, model())).baseURL).toBe(
      'https://gemini-gw.internal/v1beta',
    );
  });

  it('authenticates with the key header rather than a Bearer token', () => {
    const headers = requestHeaders(createProvider(provider(), model()));
    expect(headers['x-goog-api-key']).toBe('g-key');
    expect(headers.authorization).toBeUndefined();
  });

  it('sends the model id unchanged', () => {
    const resolved = createProvider(provider(), model({ modelId: 'gemini-3-pro-preview' }));
    expect((resolved.model as unknown as { modelId: string }).modelId).toBe('gemini-3-pro-preview');
  });

  it('leaves reasoning off entirely by default', () => {
    // Same rule as every other protocol: a model that never opted into a level
    // must produce the request it produced before the setting existed. Gemini
    // rejects `thinkingConfig` outright on models that cannot think, so an
    // unconditional option here would break them.
    const resolved = createProvider(provider(), model());
    expect('reasoning' in resolved).toBe(false);
    expect(resolved.providerOptions).toBeUndefined();
    expect('rawReasoning' in resolved).toBe(false);
  });

  it('routes a unified level and asks for the thought summary alongside it', () => {
    // Gemini thinks silently: the level sets the budget, but `includeThoughts` is
    // what makes the thoughts come back as reasoning parts. Without it every
    // thinking model would run with an empty reasoning block, unlike Anthropic and
    // OpenAI, whose thinking is requested by the SDK.
    const resolved = createProvider(provider(), model({ reasoningEffort: 'high' }));
    expect(resolved.reasoning).toBe('high');
    expect(resolved.providerOptions?.google).toEqual({
      thinkingConfig: { includeThoughts: true },
    });
  });

  it('does not need the Chat-Completions reasoning recovery', () => {
    // Gemini's own parser maps `part.thought` into reasoning parts, so the
    // gateway rewrite that exists for OpenAI-shaped streams must stay off.
    const resolved = createProvider(provider(), model({ reasoningEffort: 'low' }));
    expect(resolved.rawReasoning).toBeUndefined();
  });
});

describe('google model list', () => {
  it('is the /models sibling of the base, and is fetchable for a custom provider', () => {
    expect(resolveModelsUrl(provider({ baseUrl: 'https://gw.internal/v1beta' }))).toBe(
      'https://gw.internal/v1beta/models',
    );
    expect(canFetchModels({ vendor: 'custom', type: 'google' })).toBe(true);
  });

  it('asks for one full page, because 50 would silently hide most of the catalogue', () => {
    const request = resolveModelListRequest({
      vendor: 'custom',
      type: 'google',
      baseUrl: 'https://gw.internal/v1beta',
      apiKey: '  g-key  ',
    });
    expect(request).toEqual({
      url: 'https://gw.internal/v1beta/models?pageSize=1000',
      headers: { 'x-goog-api-key': 'g-key' },
    });
  });

  it('keeps the Bearer request for the OpenAI protocols', () => {
    // The protocol-specific parts must not leak: `pageSize` is not a parameter
    // every gateway accepts, and a Google key header on OpenAI is a 401.
    const request = resolveModelListRequest({
      vendor: 'custom',
      type: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    });
    expect(request).toEqual({
      url: 'https://api.example.com/v1/models',
      headers: { Authorization: 'Bearer sk-test' },
    });
  });

  it('answers with nothing when no URL can be derived', () => {
    expect(resolveModelListRequest({ vendor: 'custom', type: 'google', apiKey: 'g-key' }))
      .toBeUndefined();
  });
});

describe('parseModelList on a Gemini payload', () => {
  it('strips the resource prefix and reads the published details', () => {
    // The name is a resource path; the id a request takes is the bare tail.
    expect(
      parseModelList({
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            inputTokenLimit: 1_048_576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        ],
      }),
    ).toEqual([
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1_048_576 },
    ]);
  });

  it('drops the embedding and speech models the catalogue mixes in', () => {
    // Gemini lists every model it serves; picking `text-embedding-004` for a chat
    // would fail at request time, and the payload already says so.
    expect(
      parseModelList({
        models: [
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }).map((entry) => entry.id),
    ).toEqual(['gemini-2.5-flash']);
  });

  it('still reads the OpenAI-shaped envelope', () => {
    expect(parseModelList({ data: [{ id: 'gpt-4o' }] })).toEqual([{ id: 'gpt-4o' }]);
  });
});

describe('the Gemini request on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Capture one real request the SDK builds, answering with a valid reply. */
  async function captureRequest(modelOverrides: Partial<ModelConfig> = {}) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'SUMMARY' }] }, finishReason: 'STOP', index: 0 },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi', state: 'done' }], timestamp: 1 },
    ];
    await generateCompactionSummary({ provider: provider(), model: model(modelOverrides), messages });

    const request = requests.at(-1)!;
    const headers = request.init?.headers as Record<string, string>;
    return { url: request.url, headers, body: JSON.parse(String(request.init?.body)) };
  }

  it('calls the model method on the versioned base with the key header', async () => {
    const { url, headers } = await captureRequest();
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(headers['x-goog-api-key']).toBe('g-key');
    expect(headers.authorization).toBeUndefined();
  });

  it('sends no thinking config when no level was chosen', async () => {
    const { body } = await captureRequest();
    expect(body.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('merges the thought-summary switch with the budget derived from the level', async () => {
    // The risk this guards: `includeThoughts` is written into the same
    // `thinkingConfig` the SDK derives the budget into. Sent as a replacement
    // rather than merged, the level would be dropped and Gemini would think at its
    // default depth instead of the one the user chose.
    const { body } = await captureRequest({ reasoningEffort: 'high' });
    expect(body.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  });
});

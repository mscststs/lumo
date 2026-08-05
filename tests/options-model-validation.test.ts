import { describe, it, expect } from 'vitest';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import {
  normalizeModelDraft,
  normalizeProviderDraft,
  validateModel,
  validateProvider,
} from '@/entrypoints/options/models/validation';
import type { ModelConfig, ProviderConfig } from '@/types';

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'My Provider',
    type: 'openai-chat',
    apiKey: 'sk-test',
    models: [],
    ...overrides,
  };
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { id: 'm1', modelId: 'gpt-4o', displayName: 'GPT-4o', isVision: false, ...overrides };
}

/** Resolves a dotted i18n key against a locale bundle. */
function lookup(bundle: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], bundle);
}

describe('validateProvider', () => {
  it('accepts a provider with a name and key and no base URL', () => {
    expect(validateProvider(provider({ baseUrl: undefined }), [])).toEqual({});
  });

  it('requires a name and rejects whitespace-only input', () => {
    expect(validateProvider(provider({ name: '   ' }), []).name).toBe(
      'options.models.errors.nameRequired',
    );
  });

  it('requires an API key', () => {
    expect(validateProvider(provider({ apiKey: '' }), []).apiKey).toBe(
      'options.models.errors.apiKeyRequired',
    );
  });

  it('rejects a name already used by another provider', () => {
    const existing = [provider({ id: 'other', name: 'My Provider' })];
    expect(validateProvider(provider(), existing).name).toBe(
      'options.models.errors.nameDuplicate',
    );
  });

  it('does not flag a provider for colliding with itself while editing', () => {
    const existing = [provider({ id: 'p1', name: 'My Provider' })];
    expect(validateProvider(provider({ apiKey: 'sk-new' }), existing).name).toBeUndefined();
  });

  it('rejects a base URL that is not an absolute http(s) URL', () => {
    for (const baseUrl of ['api.openai.com', 'ws://x.dev', '/v1', 'not a url']) {
      expect(validateProvider(provider({ baseUrl }), []).baseUrl).toBe(
        'options.models.errors.baseUrlInvalid',
      );
    }
  });

  it('accepts http and https base URLs', () => {
    for (const baseUrl of ['http://localhost:11434/v1', 'https://api.deepseek.com/v1']) {
      expect(validateProvider(provider({ baseUrl }), []).baseUrl).toBeUndefined();
    }
  });

  it('treats a blank base URL as omitted rather than invalid', () => {
    expect(validateProvider(provider({ baseUrl: '  ' }), []).baseUrl).toBeUndefined();
  });
});

describe('validateModel', () => {
  it('accepts a complete model', () => {
    expect(validateModel(model(), [])).toEqual({});
  });

  it('requires a model id and a display name', () => {
    const errors = validateModel(model({ modelId: '', displayName: ' ' }), []);
    expect(errors.modelId).toBe('options.models.errors.modelIdRequired');
    expect(errors.displayName).toBe('options.models.errors.displayNameRequired');
  });

  it('rejects a model id already present on the same provider', () => {
    const siblings = [model({ id: 'other', modelId: 'gpt-4o' })];
    expect(validateModel(model(), siblings).modelId).toBe(
      'options.models.errors.modelIdDuplicate',
    );
  });

  it('allows an existing model to keep its own id while editing', () => {
    const siblings = [model({ id: 'm1', modelId: 'gpt-4o' })];
    expect(validateModel(model({ displayName: 'Renamed' }), siblings).modelId).toBeUndefined();
  });
});

describe('draft normalization', () => {
  it('trims provider fields and drops an empty base URL', () => {
    const result = normalizeProviderDraft(
      provider({ name: '  Acme  ', apiKey: ' sk-1 ', baseUrl: '   ' }),
    );
    expect(result.name).toBe('Acme');
    expect(result.apiKey).toBe('sk-1');
    // `lib/ai.ts` branches on `baseUrl` being undefined to apply its default,
    // so an empty string must not survive.
    expect(result.baseUrl).toBeUndefined();
  });

  it('trims a provided base URL rather than discarding it', () => {
    expect(normalizeProviderDraft(provider({ baseUrl: ' https://x.dev/v1 ' })).baseUrl).toBe(
      'https://x.dev/v1',
    );
  });

  it('trims model fields', () => {
    const result = normalizeModelDraft(model({ modelId: ' gpt-4o ', displayName: ' GPT ' }));
    expect(result).toMatchObject({ modelId: 'gpt-4o', displayName: 'GPT' });
  });
});

describe('validation error keys resolve in every locale', () => {
  // The validators return i18n keys, so a typo would surface to the user as the
  // raw key rather than a message. Assert every key exists in both bundles.
  const keys = [
    ...Object.values(validateProvider(provider({ name: '', apiKey: '', baseUrl: 'x' }), [])),
    ...Object.values(validateProvider(provider(), [provider({ id: 'o' })])),
    ...Object.values(validateModel(model({ modelId: '', displayName: '' }), [])),
    ...Object.values(validateModel(model(), [model({ id: 'o' })])),
  ].filter((key): key is string => typeof key === 'string');

  it('produces keys for every failure mode', () => {
    // 3 provider fields + duplicate name, 2 model fields + duplicate model id.
    expect(new Set(keys).size).toBe(7);
  });

  it.each(['en', 'zh'] as const)('resolves all keys in %s', (locale) => {
    const bundle = locale === 'en' ? en : zh;
    for (const key of keys) {
      expect(lookup(bundle, key), `${key} missing from ${locale}`).toBeTypeOf('string');
    }
  });
});

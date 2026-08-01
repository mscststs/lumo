import type { ProviderConfig, ProviderType, StoredProviderType } from '@/types';

/** i18n key suffix under `options.models.providerTypes` for each type. */
export const PROVIDER_TYPE_I18N_KEY: Record<ProviderType, string> = {
  anthropic: 'anthropic',
  'openai-chat': 'openaiChat',
  'openai-responses': 'openaiResponses',
};

/** Order shown in the provider type picker, most portable option first. */
export const PROVIDER_TYPES: ProviderType[] = [
  'openai-chat',
  'openai-responses',
  'anthropic',
];

/** Default base URL hint per provider type, used as an input placeholder. */
export const PROVIDER_BASE_URL_PLACEHOLDER: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
};

/**
 * Map a persisted provider type onto a current one.
 *
 * Legacy `openai-compatible` configs pointed at arbitrary gateways but were
 * actually dispatched to the OpenAI Responses API, which those gateways do not
 * implement. They are migrated to `openai-chat` (`/chat/completions`), which is
 * what the label promised and what such gateways actually serve.
 */
export function normalizeProviderType(type: StoredProviderType | undefined): ProviderType {
  if (type === 'openai-compatible' || type === undefined) return 'openai-chat';
  return type;
}

/** Read a stored provider with its type migrated to a current value. */
export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  const type = normalizeProviderType(provider.type as StoredProviderType);
  return type === provider.type ? provider : { ...provider, type };
}

/** Whether the provider speaks one of the OpenAI wire protocols. */
export function isOpenAIProvider(type: ProviderType): boolean {
  return type === 'openai-chat' || type === 'openai-responses';
}

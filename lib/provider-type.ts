import type { ModelConfig, ProviderConfig, ProviderType, StoredProviderType } from '@/types';
import {
  REASONING_EFFORT_DEFAULT,
  normalizeReasoningEffort,
} from '@/lib/reasoning-effort';

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

/**
 * Read a stored model with its reasoning effort migrated to a current value.
 *
 * An absent field is left absent: it already *means* "provider default", and
 * materialising that on read would rewrite every model stored before the
 * setting existed. Only a present value can be stale — a level written by a
 * build that knows one this doesn't, which must not be forwarded to the API,
 * where it would fail the whole request rather than degrade.
 *
 * Returns the same object when nothing changed, so an ordinary read does not
 * hand React a fresh identity for every row.
 */
function normalizeModel(model: ModelConfig): ModelConfig {
  if (model.reasoningEffort === undefined) return model;
  const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
  return reasoningEffort === model.reasoningEffort ? model : { ...model, reasoningEffort };
}

/** Read a stored provider with its type and models migrated to current values. */
export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  const type = normalizeProviderType(provider.type as StoredProviderType);
  // Tolerate a `models`-less object rather than throwing: this also runs on
  // imported config files, which are not guaranteed to be well-formed.
  const models = Array.isArray(provider.models) ? provider.models.map(normalizeModel) : undefined;
  const modelsChanged = models?.some((model, i) => model !== provider.models[i]) ?? false;
  if (type === provider.type && !modelsChanged) return provider;
  return { ...provider, type, ...(modelsChanged ? { models: models! } : {}) };
}

/** Whether the provider speaks one of the OpenAI wire protocols. */
export function isOpenAIProvider(type: ProviderType): boolean {
  return type === 'openai-chat' || type === 'openai-responses';
}

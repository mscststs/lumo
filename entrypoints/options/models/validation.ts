import type { ModelConfig, ProviderConfig } from '@/types';

/**
 * Field-level validation for the provider and model forms.
 *
 * Kept pure and separate from the components: the previous implementation
 * inlined `if (!name || !apiKey) return`, which meant a failed save was a
 * silent no-op with no indication of which field was at fault. These functions
 * return an i18n *key* per field so the form can render a message next to the
 * offending input while the copy stays translatable.
 */

/** Map of field name → i18n key describing the problem. Empty means valid. */
export type ValidationErrors<T extends string> = Partial<Record<T, string>>;

export type ProviderField = 'name' | 'baseUrl' | 'apiKey';
export type ModelField = 'modelId' | 'displayName';

const ERROR_KEY = 'options.models.errors';

/**
 * Whether `value` is usable as a provider base URL.
 *
 * Only http(s) is accepted: the AI SDK passes this straight to `fetch`, so a
 * `ws:` or bare `example.com` value fails at request time with an opaque
 * network error instead of here.
 */
function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateProvider(
  draft: ProviderConfig,
  /** The persisted list, used to reject a duplicate display name. */
  existing: ProviderConfig[],
): ValidationErrors<ProviderField> {
  const errors: ValidationErrors<ProviderField> = {};
  const name = draft.name.trim();

  if (!name) {
    errors.name = `${ERROR_KEY}.nameRequired`;
  } else if (existing.some((p) => p.id !== draft.id && p.name.trim() === name)) {
    // Duplicate names are legal in storage but make the sidebar's grouped model
    // picker ambiguous, so they are rejected at the form.
    errors.name = `${ERROR_KEY}.nameDuplicate`;
  }

  // `baseUrl` is optional — an empty value falls back to the provider default
  // in `lib/ai.ts` — but a non-empty one must actually be fetchable.
  const baseUrl = draft.baseUrl?.trim();
  if (baseUrl && !isValidHttpUrl(baseUrl)) {
    errors.baseUrl = `${ERROR_KEY}.baseUrlInvalid`;
  }

  if (!draft.apiKey.trim()) {
    errors.apiKey = `${ERROR_KEY}.apiKeyRequired`;
  }

  return errors;
}

export function validateModel(
  draft: ModelConfig,
  /** Sibling models in the same provider, used to reject a duplicate model id. */
  siblings: ModelConfig[],
): ValidationErrors<ModelField> {
  const errors: ValidationErrors<ModelField> = {};
  const modelId = draft.modelId.trim();

  if (!modelId) {
    errors.modelId = `${ERROR_KEY}.modelIdRequired`;
  } else if (siblings.some((m) => m.id !== draft.id && m.modelId.trim() === modelId)) {
    errors.modelId = `${ERROR_KEY}.modelIdDuplicate`;
  }

  if (!draft.displayName.trim()) {
    errors.displayName = `${ERROR_KEY}.displayNameRequired`;
  }

  return errors;
}

/** Trims the free-text fields so stored values never carry stray whitespace. */
export function normalizeProviderDraft(draft: ProviderConfig): ProviderConfig {
  const baseUrl = draft.baseUrl?.trim();
  return {
    ...draft,
    name: draft.name.trim(),
    // Normalise "" to undefined so `lib/ai.ts` takes its default-URL branch.
    baseUrl: baseUrl || undefined,
    apiKey: draft.apiKey.trim(),
  };
}

export function normalizeModelDraft(draft: ModelConfig): ModelConfig {
  return {
    ...draft,
    modelId: draft.modelId.trim(),
    displayName: draft.displayName.trim(),
  };
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.keys(errors).length > 0;
}

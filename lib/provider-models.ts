/**
 * Reading a provider's `/models` response.
 *
 * Gateways agree on `{ data: [...] }` and little else: entries may be bare ids,
 * OpenAI-style `{ id }` objects or LiteLLM-style `{ model_name }`. Some (Magpie)
 * also describe each model, and the details that map onto a `ModelConfig` are
 * kept so the dialog can prefill them instead of making the user retype them.
 *
 * Gemini returns `{ models: [...] }` instead, names each entry `models/<id>` and
 * describes it with `displayName` / `inputTokenLimit`, so the same reading runs
 * over both shapes rather than the dialog growing a protocol-specific branch.
 */

import { normalizeContextWindow } from '@/lib/context-window';

export interface FetchedModel {
  id: string;
  /** Human-readable name, when the gateway publishes one distinct from the id. */
  displayName?: string;
  /** Declared context window in tokens, already range-checked. */
  contextWindow?: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Model id as the provider names it in a list entry.
 *
 * Gemini prefixes the id with the resource collection (`models/gemini-2.5-pro`),
 * which is a path, not the id a request takes; the prefix is stripped so the
 * picked value is what `createGoogleGenerativeAI` will actually call.
 */
function readId(entry: Record<string, unknown>): string | undefined {
  const id = readString(entry.id) ?? readString(entry.model_name) ?? readString(entry.name);
  return id?.replace(/^models\//, '');
}

/**
 * Whether a listed model can answer a chat request.
 *
 * Gemini publishes embedding and speech models in the same catalogue, flagged
 * only by `supportedGenerationMethods`. Offering `text-embedding-004` in a chat
 * model picker is a dead end the list itself already knows about, so entries
 * that declare a method set without `generateContent` are dropped. A payload
 * without the field (every OpenAI-shaped gateway) is taken at face value.
 */
function canGenerateContent(entry: Record<string, unknown>): boolean {
  const methods = entry.supportedGenerationMethods;
  return !Array.isArray(methods) || methods.includes('generateContent');
}

function readEntry(item: unknown): FetchedModel | undefined {
  if (typeof item === 'string') return item ? { id: item.replace(/^models\//, '') } : undefined;
  if (!item || typeof item !== 'object') return undefined;
  const entry = item as Record<string, unknown>;
  const id = readId(entry);
  if (!id || !canGenerateContent(entry)) return undefined;
  // `display_name` is Magpie's and LiteLLM's name; `displayName` is Gemini's.
  const displayName = readString(entry.display_name) ?? readString(entry.displayName);
  // `context_window` is Magpie's name; `context_length` is OpenRouter's and is
  // also published by Magpie with the same value; `inputTokenLimit` is Gemini's.
  const contextWindow = normalizeContextWindow(
    entry.context_window ?? entry.context_length ?? entry.inputTokenLimit,
  );
  return {
    id,
    ...(displayName && displayName !== id ? { displayName } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * Models listed in a `/models` payload, deduplicated by id and sorted by it.
 *
 * Reads both the `{ data: [...] }` envelope every OpenAI-shaped gateway uses and
 * Gemini's `{ models: [...] }`. Returns an empty list for anything that is not
 * shaped like a model list, so the caller has one "nothing usable" case to
 * report.
 */
export function parseModelList(payload: unknown): FetchedModel[] {
  if (!payload || typeof payload !== 'object') return [];
  const envelope = payload as { data?: unknown; models?: unknown };
  const data = Array.isArray(envelope.data)
    ? envelope.data
    : Array.isArray(envelope.models)
      ? envelope.models
      : undefined;
  if (!data) return [];
  const byId = new Map<string, FetchedModel>();
  for (const item of data) {
    const model = readEntry(item);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

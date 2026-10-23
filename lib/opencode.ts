/**
 * OpenCode (Zen / Console) vendor specifics.
 *
 * OpenCode is not "just another OpenAI-compatible gateway": it multiplexes
 * several wire protocols behind protocol-specific paths, gates routing on
 * client-identifying request headers, and publishes its model list at a path
 * that is a *sibling* of those protocol paths rather than underneath them. All
 * of that lives here so `lib/ai.ts` and the options UI can stay protocol-only.
 *
 * Endpoints (see https://opencode.ai/docs/zen/):
 * - OpenAI Chat / Responses base: `${origin}/inference/openai/v1`
 * - Anthropic base:               `${origin}/inference/anthropic`
 * - Model list:                   `${origin}/inference/v1/models`
 */

import type { ProviderType } from '@/types';
import { sha256Hex } from '@/lib/hash';

/** Default origin, used when a vendor-OpenCode provider leaves its URL empty. */
export const OPENCODE_ORIGIN = 'https://opencode.ai';

/**
 * Client identity sent as `x-opencode-client`.
 *
 * OpenCode attributes (and, on the free tier, restricts) traffic by client, so
 * this identifies Lumo rather than borrowing another agent's name.
 */
export const OPENCODE_CLIENT = 'lumo';

/**
 * Salt mixed into the session hash.
 *
 * The point is de-identification, not secrecy: OpenCode sees a stable
 * pseudonym rather than the conversation's own id. It is a constant because the
 * entropy that makes the digest unguessable comes from the conversation id
 * (a UUID), not from the salt.
 */
const OPENCODE_SESSION_SALT = 'lumo.opencode.session.v1';

/** Protocol-specific base URL on the OpenCode origin. */
export function openCodeBaseUrl(type: ProviderType, origin = OPENCODE_ORIGIN): string {
  // Gemini is served at `/inference/google/v1beta`, which `ProviderType` cannot
  // express, so every supported protocol maps onto one of the two paths below.
  return type === 'anthropic'
    ? `${trimOrigin(origin)}/inference/anthropic`
    : `${trimOrigin(origin)}/inference/openai/v1`;
}

/**
 * Model-list URL derived from a resolved OpenCode base URL.
 *
 * The list is served once at `${origin}/inference/v1/models`, *not* under the
 * protocol path — appending `/models` to an OpenCode base URL 404s. Deriving it
 * from the base rather than hardcoding the origin also keeps a self-hosted
 * OpenCode under a subpath working.
 */
export function openCodeModelsUrl(baseUrl: string): string {
  const root = baseUrl
    .replace(/\/+$/, '')
    .replace(/\/(?:openai(?:\/v1)?|anthropic|google(?:\/v1beta)?)$/, '');
  return `${root}/v1/models`;
}

/**
 * Derive OpenCode's per-conversation routing identifier.
 *
 * Deterministic on purpose: the same conversation must present the same id on
 * every request so OpenCode can keep routing and prompt-cache affinity. The
 * `ses_<64 hex>` shape matches what OpenCode's own client sends.
 */
export async function deriveOpenCodeSession(seed: string): Promise<string> {
  return `ses_${await sha256Hex(`${seed}\u0000${OPENCODE_SESSION_SALT}`)}`;
}

/** Request headers OpenCode requires for a given session, if one is known. */
export function openCodeHeaders(sessionId?: string): Record<string, string> {
  return {
    'x-opencode-client': OPENCODE_CLIENT,
    ...(sessionId ? { 'x-opencode-session': sessionId } : {}),
  };
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

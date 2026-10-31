import { isExtensionId } from '@/lib/mcp/extension-protocol';
import type { McpHttpServerConfig } from '@/lib/mcp/types';

/**
 * Field-level validation for the MCP add dialogs.
 *
 * Mirrors `options/models/validation.ts`: these functions are pure and return an
 * i18n *key* per field, so the dialogs can render a translated message next to
 * the offending control instead of the single hard-coded English string the old
 * inline forms showed ("Invalid URL format") — or, worse, a silent no-op.
 */

/** Map of field name → i18n key describing the problem. Empty means valid. */
export type ValidationErrors<T extends string> = Partial<Record<T, string>>;

export type ServerField = 'name' | 'url';
export type ExtensionField = 'id';

const SERVER_ERROR_KEY = 'options.mcp.errors';
const EXTENSION_ERROR_KEY = 'options.mcp.extensions';

/**
 * Whether `value` is usable as an MCP endpoint.
 *
 * Only http(s) is accepted: both transports are implemented on `fetch`, so a
 * `ws:` or bare `example.com` value would fail at connect time with an opaque
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

export function validateServer(draft: McpHttpServerConfig): ValidationErrors<ServerField> {
  const errors: ValidationErrors<ServerField> = {};

  if (!draft.name.trim()) errors.name = `${SERVER_ERROR_KEY}.required`;

  const url = draft.url.trim();
  if (!url) {
    errors.url = `${SERVER_ERROR_KEY}.required`;
  } else if (!isValidHttpUrl(url)) {
    errors.url = `${SERVER_ERROR_KEY}.invalidUrl`;
  }

  return errors;
}

/** Chrome extension IDs are 32 lowercase a–p characters; format is all we can check. */
export function validateExtension(
  id: string,
  /** Providers already configured, so a double add is rejected up front. */
  configured: readonly string[],
): ValidationErrors<ExtensionField> {
  const value = id.trim();
  if (!isExtensionId(value)) return { id: `${EXTENSION_ERROR_KEY}.invalidId` };
  if (configured.includes(value)) return { id: `${EXTENSION_ERROR_KEY}.duplicate` };
  return {};
}

/** Trims free-text fields so stored values never carry stray whitespace. */
export function normalizeServerDraft(draft: McpHttpServerConfig): McpHttpServerConfig {
  const description = draft.description.trim();
  return {
    ...draft,
    name: draft.name.trim(),
    description,
    url: draft.url.trim(),
    // Absent rather than `{}` so "no custom headers" has one representation.
    headers: draft.headers && Object.keys(draft.headers).length > 0 ? draft.headers : undefined,
  };
}

/**
 * Parse a `Key: value` header block, one per line.
 *
 * Malformed lines are skipped rather than reported: the textarea is the only
 * editor for this optional field, and a line without a colon cannot be turned
 * into a header, so failing the whole save would help nobody. Blank lines are
 * the normal way to space out a long block.
 */
export function parseHeaderLines(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Serialise stored headers back into the textarea's line format. */
export function headersToText(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.keys(errors).length > 0;
}

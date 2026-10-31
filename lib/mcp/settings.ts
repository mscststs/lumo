import type { McpExtensionProviderConfig, McpSettings } from './types';

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  servers: [],
  disabledBuiltins: [],
  webmcpEnabled: false,
  extensionProviders: [],
};

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Repair an extension provider list.
 *
 * Stored records can come from an older build (no field), a hand-edited export,
 * or a user paste. Invalid IDs are dropped rather than kept as entries that can
 * never connect; duplicates are collapsed so one extension cannot open two
 * sessions under the same name.
 */
export function normalizeExtensionProviders(value: unknown): McpExtensionProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: McpExtensionProviderConfig[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || !EXTENSION_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    result.push({
      id,
      enabled: record.enabled !== false,
      ...(label ? { label } : {}),
    });
  }
  return result.slice(0, 16);
}

/** Fill fields added after the first release, and validate the list. */
export function normalizeMcpSettings(raw: Partial<McpSettings> | undefined): McpSettings {
  // `injectInstructions` now lives in the system prompt settings. Drop it from
  // stored records so a stale key cannot ride along into an exported bundle.
  const { injectInstructions: _legacy, ...rest } = (raw ?? {}) as Partial<McpSettings> & {
    injectInstructions?: boolean;
  };
  return {
    ...DEFAULT_MCP_SETTINGS,
    ...rest,
    servers: Array.isArray(rest.servers) ? rest.servers : [],
    disabledBuiltins: Array.isArray(rest.disabledBuiltins)
      ? rest.disabledBuiltins.filter((id): id is string => typeof id === 'string')
      : [],
    webmcpEnabled: rest.webmcpEnabled === true,
    extensionProviders: normalizeExtensionProviders(rest.extensionProviders),
  };
}

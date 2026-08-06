/**
 * Declarative Storage Schema Registry
 *
 * All chrome.storage keys are declared here with metadata.
 * The `exportable` flag controls whether a key is included in config
 * import/export — new settings only need to be added to this registry
 * and they will automatically be covered by export/import.
 *
 * Adding a new setting:
 * 1. Define its type in `StorageSchema` interface
 * 2. Add a `StorageFieldDef` entry in `STORAGE_FIELDS`
 * 3. Done — export/import/watch types all derive from this file.
 *
 * ## What belongs here
 *
 * `chrome.storage.local` is capped at 10 MB (the `unlimitedStorage` permission
 * is deliberately not requested) and serialises a whole key on every write, so
 * this area is reserved for values that are **bounded in size** and need
 * `onChanged` to reach other extension contexts — settings, selections and
 * pointers.
 *
 * Data that grows with use must not live here. Chat history used to, under a
 * single `conversations` key, which exhausted the quota and made every
 * subsequent write throw `Resource::kQuotaBytes quota exceeded`. It now lives in
 * IndexedDB (`lib/conversation-store.ts`); `conversationsRevision` below is the
 * bounded counter that replaces it as the change-broadcast channel.
 */

import type {
  ProviderConfig,
  UISettings,
  SystemPromptSettings,
} from '@/types';
import type { McpSettings } from '@/lib/mcp/types';
import { normalizeProvider } from '@/lib/provider-type';
import { DEFAULT_SYSTEM_PROMPT_SETTINGS } from '@/lib/system-prompt';
import { DEFAULT_THEME, normalizeTheme } from '@/lib/theme-registry';

// ---------------------------------------------------------------------------
// 1. Schema: all possible storage keys and their value types
// ---------------------------------------------------------------------------

/**
 * The single source of truth for what lives in chrome.storage.local.
 * Every key used anywhere in the app MUST be listed here.
 *
 * Every value here is bounded — see the note at the top of this file.
 */
export interface StorageSchema {
  providers: ProviderConfig[];
  uiSettings: UISettings;
  currentConversationId: string | null;
  selectedModel: { providerId: string; modelId: string } | null;
  mcpSettings: McpSettings;
  systemPrompt: SystemPromptSettings;
  /**
   * Bumped after every write to the conversation database.
   *
   * IndexedDB has no cross-context change event, so this counter is the signal
   * other contexts (a second side panel, the options page) watch to know they
   * should re-read. Only the counter crosses `chrome.storage`, never the data.
   */
  conversationsRevision: number;
}

// ---------------------------------------------------------------------------
// 2. Derived utility types (auto-generated from StorageSchema)
// ---------------------------------------------------------------------------

/** Union of all valid storage key strings */
export type StorageKey = keyof StorageSchema;

// ---------------------------------------------------------------------------
// 3. Field definition & registry
// ---------------------------------------------------------------------------

export interface StorageFieldDef<K extends StorageKey> {
  /** The chrome.storage.local key name */
  key: K;
  /** Default value when nothing is stored */
  defaultValue: StorageSchema[K];
  /**
   * Whether this field should be included in config export/import.
   * Set to `false` for runtime/ephemeral data (e.g. conversations).
   */
  exportable: boolean;
  /**
   * Optional migration/normalization function applied on read AND on import.
   * Use this for backwards-compat transforms (e.g. provider type migration).
   */
  normalize?: (raw: StorageSchema[K]) => StorageSchema[K];
}

// ---------------------------------------------------------------------------
// 4. The registry — THE place to add new settings
// ---------------------------------------------------------------------------

const DEFAULT_UI_SETTINGS: UISettings = {
  language: 'en',
  theme: DEFAULT_THEME,
  maxSplitPanels: 1,
  sendKey: 'enter',
};

const DEFAULT_MCP_SETTINGS: McpSettings = {
  servers: [],
  disabledBuiltins: [],
  webmcpEnabled: false,
};

/**
 * Central registry of all storage fields.
 *
 * To add a new setting:
 * 1. Add the key + type to `StorageSchema`
 * 2. Add a field entry below with `exportable: true`
 * 3. That's it — export/import picks it up automatically.
 */
export const STORAGE_FIELDS: { [K in StorageKey]: StorageFieldDef<K> } = {
  providers: {
    key: 'providers',
    defaultValue: [],
    exportable: true,
    normalize: (raw) => raw.map(normalizeProvider),
  },
  uiSettings: {
    key: 'uiSettings',
    defaultValue: DEFAULT_UI_SETTINGS,
    exportable: true,
    normalize: (raw) => ({
      ...raw,
      // Guards configs exported by a build that knows a theme this one does not
      // (and pre-field configs). An unrecognised value would otherwise reach
      // `data-theme`, match no token block, and silently leave light tokens.
      theme: normalizeTheme(raw.theme),
      maxSplitPanels: raw.maxSplitPanels ?? 1,
      sendKey: raw.sendKey ?? 'enter',
    }),
  },
  systemPrompt: {
    key: 'systemPrompt',
    defaultValue: DEFAULT_SYSTEM_PROMPT_SETTINGS,
    exportable: true,
    normalize: (raw) => ({
      ...raw,
      injectCurrentTime: raw.injectCurrentTime ?? true,
    }),
  },
  mcpSettings: {
    key: 'mcpSettings',
    defaultValue: DEFAULT_MCP_SETTINGS,
    exportable: true,
  },
  selectedModel: {
    key: 'selectedModel',
    defaultValue: null,
    exportable: true,
  },
  conversationsRevision: {
    key: 'conversationsRevision',
    defaultValue: 0,
    exportable: false,
  },
  currentConversationId: {
    key: 'currentConversationId',
    defaultValue: null,
    exportable: false,
  },
};

// ---------------------------------------------------------------------------
// 5. Helpers derived from registry
// ---------------------------------------------------------------------------

/** All keys that have `exportable: true` */
export const EXPORTABLE_KEYS: StorageKey[] = (
  Object.keys(STORAGE_FIELDS) as StorageKey[]
).filter((k) => STORAGE_FIELDS[k].exportable);

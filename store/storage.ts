import type {
  ProviderConfig,
  UISettings,
  Conversation,
  SystemPromptSettings,
} from '@/types';
import type { McpSettings } from '@/lib/mcp/types';
import {
  STORAGE_FIELDS,
  EXPORTABLE_KEYS,
  type StorageSchema,
  type StorageKey,
} from './storage-schema';

// ---------------------------------------------------------------------------
// Generic helpers driven by the schema registry
// ---------------------------------------------------------------------------

/** Read a single key from chrome.storage.local, applying defaults + normalize */
async function getField<K extends StorageKey>(key: K): Promise<StorageSchema[K]> {
  const field = STORAGE_FIELDS[key];
  const result = await chrome.storage.local.get(key);
  const raw = result[key] as StorageSchema[K] | undefined;
  if (raw === undefined) return field.defaultValue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return field.normalize ? (field.normalize as any)(raw) : raw;
}

/** Write a single key to chrome.storage.local */
async function setField<K extends StorageKey>(
  key: K,
  value: StorageSchema[K],
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// ---------------------------------------------------------------------------
// Exported config type — automatically covers all exportable keys
// ---------------------------------------------------------------------------

/**
 * Portable configuration bundle for import/export.
 * At runtime, only keys with `exportable: true` in the registry are
 * actually written/read. The type is permissive (partial of full schema)
 * so that older config files with missing keys import cleanly.
 */
export type AppConfig = Partial<StorageSchema>;

// ---------------------------------------------------------------------------
// Public API — preserves the exact same method signatures for compatibility
// ---------------------------------------------------------------------------

// Storage helpers using chrome.storage.local
export const storage = {
  // ----- Providers -----
  async getProviders(): Promise<ProviderConfig[]> {
    return getField('providers');
  },
  async setProviders(providers: ProviderConfig[]): Promise<void> {
    await setField('providers', providers);
  },

  // ----- UI Settings -----
  async getUISettings(): Promise<UISettings> {
    return getField('uiSettings');
  },
  async setUISettings(settings: UISettings): Promise<void> {
    await setField('uiSettings', settings);
  },

  // ----- Conversations -----
  async getConversations(): Promise<Conversation[]> {
    return getField('conversations');
  },
  async setConversations(conversations: Conversation[]): Promise<void> {
    await setField('conversations', conversations);
  },

  /**
   * Inserts or replaces a conversation and returns the persisted list.
   * Reads immediately before writing so concurrent updates from another
   * context are not clobbered by a stale in-memory copy.
   *
   * Pass `insertIfMissing: false` to skip conversations that no longer exist —
   * a stream settling after its conversation was deleted must not recreate it.
   */
  async upsertConversation(
    conversation: Conversation,
    { insertIfMissing = true }: { insertIfMissing?: boolean } = {},
  ): Promise<Conversation[]> {
    const all = await this.getConversations();
    const idx = all.findIndex((c) => c.id === conversation.id);
    if (idx >= 0) {
      all[idx] = conversation;
    } else {
      if (!insertIfMissing) return all;
      all.unshift(conversation);
    }
    await this.setConversations(all);
    return all;
  },

  // ----- Current Conversation ID -----
  async getCurrentConversationId(): Promise<string | null> {
    return getField('currentConversationId');
  },
  async setCurrentConversationId(id: string | null): Promise<void> {
    await setField('currentConversationId', id);
  },

  // ----- Selected Model -----
  async getSelectedModel(): Promise<{ providerId: string; modelId: string } | null> {
    return getField('selectedModel');
  },
  async setSelectedModel(
    model: { providerId: string; modelId: string } | null,
  ): Promise<void> {
    await setField('selectedModel', model);
  },

  // ----- MCP Settings -----
  async getMcpSettings(): Promise<McpSettings> {
    return getField('mcpSettings');
  },
  async setMcpSettings(settings: McpSettings): Promise<void> {
    await setField('mcpSettings', settings);
  },

  // ----- System Prompt -----
  async getSystemPrompt(): Promise<SystemPromptSettings> {
    return getField('systemPrompt');
  },
  async setSystemPrompt(settings: SystemPromptSettings): Promise<void> {
    await setField('systemPrompt', settings);
  },

  // ----- Export / Import (driven by registry) -----

  /**
   * Export all settings marked `exportable: true` in the schema registry.
   * New settings added to the registry are automatically included.
   */
  async exportConfig(): Promise<AppConfig> {
    const keys = EXPORTABLE_KEYS;
    const result = await chrome.storage.local.get(keys);
    const config: AppConfig = {};

    for (const key of keys) {
      const field = STORAGE_FIELDS[key];
      const raw = result[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = raw === undefined ? field.defaultValue : (field.normalize ? (field.normalize as any)(raw) : raw);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)[key] = value;
    }

    return config;
  },

  /**
   * Import settings from a config bundle.
   * Only keys present in the bundle AND marked `exportable` are written.
   * Normalize functions are applied automatically.
   */
  async importConfig(config: AppConfig): Promise<void> {
    const writes: Record<string, unknown> = {};

    for (const key of EXPORTABLE_KEYS) {
      const value = (config as Record<string, unknown>)[key];
      if (value === undefined) continue;

      const field = STORAGE_FIELDS[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writes[key] = field.normalize ? (field.normalize as any)(value) : value;
    }

    // Batch write for atomicity
    if (Object.keys(writes).length > 0) {
      await chrome.storage.local.set(writes);
    }
  },
};

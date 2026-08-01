import type {
  AppConfig,
  ProviderConfig,
  UISettings,
  Conversation,
  SystemPromptSettings,
} from '@/types';
import type { McpSettings } from '@/lib/mcp/types';
import { normalizeProvider } from '@/lib/provider-type';
import { DEFAULT_SYSTEM_PROMPT_SETTINGS } from '@/lib/system-prompt';

const DEFAULT_UI_SETTINGS: UISettings = {
  language: 'en',
  theme: 'system',
};

const DEFAULT_MCP_SETTINGS: McpSettings = {
  servers: [],
  disabledBuiltins: [],
};

// Storage helpers using chrome.storage.local
export const storage = {
  async getProviders(): Promise<ProviderConfig[]> {
    const result = await chrome.storage.local.get('providers');
    const providers = (result.providers as ProviderConfig[] | undefined) || [];
    // Migrate on read so existing configs keep working without a destructive
    // rewrite; the new type is persisted the next time the user saves.
    return providers.map(normalizeProvider);
  },

  async setProviders(providers: ProviderConfig[]): Promise<void> {
    await chrome.storage.local.set({ providers });
  },

  async getUISettings(): Promise<UISettings> {
    const result = await chrome.storage.local.get('uiSettings');
    return (result.uiSettings as UISettings | undefined) || DEFAULT_UI_SETTINGS;
  },

  async setUISettings(settings: UISettings): Promise<void> {
    await chrome.storage.local.set({ uiSettings: settings });
  },

  async getConversations(): Promise<Conversation[]> {
    const result = await chrome.storage.local.get('conversations');
    return (result.conversations as Conversation[] | undefined) || [];
  },

  async setConversations(conversations: Conversation[]): Promise<void> {
    await chrome.storage.local.set({ conversations });
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

  async getCurrentConversationId(): Promise<string | null> {
    const result = await chrome.storage.local.get('currentConversationId');
    return (result.currentConversationId as string | undefined) || null;
  },

  async setCurrentConversationId(id: string | null): Promise<void> {
    await chrome.storage.local.set({ currentConversationId: id });
  },

  async getSelectedModel(): Promise<{ providerId: string; modelId: string } | null> {
    const result = await chrome.storage.local.get('selectedModel');
    return (result.selectedModel as { providerId: string; modelId: string } | undefined) || null;
  },

  async setSelectedModel(model: { providerId: string; modelId: string } | null): Promise<void> {
    await chrome.storage.local.set({ selectedModel: model });
  },

  async getMcpSettings(): Promise<McpSettings> {
    const result = await chrome.storage.local.get('mcpSettings');
    return (result.mcpSettings as McpSettings | undefined) || DEFAULT_MCP_SETTINGS;
  },

  async setMcpSettings(settings: McpSettings): Promise<void> {
    await chrome.storage.local.set({ mcpSettings: settings });
  },

  async getSystemPrompt(): Promise<SystemPromptSettings> {
    const result = await chrome.storage.local.get('systemPrompt');
    const saved = result.systemPrompt as SystemPromptSettings | undefined;
    if (!saved) return DEFAULT_SYSTEM_PROMPT_SETTINGS;
    return {
      ...saved,
      injectCurrentTime: saved.injectCurrentTime ?? true,
    };
  },

  async setSystemPrompt(settings: SystemPromptSettings): Promise<void> {
    await chrome.storage.local.set({ systemPrompt: settings });
  },

  async exportConfig(): Promise<AppConfig> {
    const [providers, uiSettings, systemPrompt] = await Promise.all([
      this.getProviders(),
      this.getUISettings(),
      this.getSystemPrompt(),
    ]);
    return { providers, uiSettings, systemPrompt };
  },

  async importConfig(config: AppConfig): Promise<void> {
    if (config.providers) {
      await this.setProviders(config.providers.map(normalizeProvider));
    }
    if (config.uiSettings) {
      await this.setUISettings(config.uiSettings);
    }
    if (config.systemPrompt) {
      await this.setSystemPrompt(config.systemPrompt);
    }
  },
};

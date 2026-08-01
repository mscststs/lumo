import type { UIMessagePart, UIDataTypes, UITools } from 'ai';

/**
 * Which wire protocol to talk to the provider with.
 *
 * The two OpenAI variants are deliberately separate because `@ai-sdk/openai` v4
 * maps them to different endpoints, and third-party gateways almost never
 * implement both:
 * - `openai-chat` → `POST {baseUrl}/chat/completions` (`openai.chat(id)`).
 *   The portable choice for DeepSeek / Moonshot / SiliconFlow / OneAPI / Ollama…
 * - `openai-responses` → `POST {baseUrl}/responses` (`openai(id)`).
 *   Only official OpenAI (or a gateway that truly proxies Responses) supports it.
 */
export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses';

/**
 * Provider types as they may appear in previously persisted configs.
 * `openai-compatible` was ambiguous: it was documented as "any compatible
 * gateway" but `openai(modelId)` resolved to the Responses API, so those
 * configs are migrated to `openai-chat` on read (see `normalizeProviderType`).
 */
export type StoredProviderType = ProviderType | 'openai-compatible';

export interface ModelConfig {
  id: string;
  modelId: string;
  displayName: string;
  isVision: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKey: string;
  models: ModelConfig[];
}

export interface UISettings {
  language: 'en' | 'zh';
  theme: 'light' | 'dark' | 'system';
}

/** User-authored system instructions prepended to every conversation. */
export interface SystemPromptSettings {
  /** Whether to send `prompt` at all. */
  enabled: boolean;
  /** Raw system prompt text. Sent verbatim, no templating. */
  prompt: string;
}

/**
 * A message part, aligned with the AI SDK `UIMessage` part union.
 * Covers text, reasoning, static tool calls (`tool-${name}`) and dynamic tool
 * calls (`dynamic-tool`), so text output and tool invocations can be rendered
 * interleaved in their original order.
 */
export type ChatMessagePart = UIMessagePart<UIDataTypes, UITools>;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /**
   * Ordered message parts. This is the source of truth for rendering.
   *
   * Legacy conversations persisted before parts existed only carry `content` /
   * `images`; use `normalizeMessage()` from `@/lib/message-parts` to read a
   * message so those are lazily upgraded into parts.
   */
  parts?: ChatMessagePart[];
  /** @deprecated Legacy flat text. Kept only so old stored conversations still render. */
  content?: string;
  /** @deprecated Legacy base64 images. Superseded by `file` parts. */
  images?: string[];
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  modelId: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppConfig {
  providers: ProviderConfig[];
  uiSettings: UISettings;
  systemPrompt?: SystemPromptSettings;
}

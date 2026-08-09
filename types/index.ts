import type { UIMessagePart, UIDataTypes, UITools } from 'ai';
import type { ReasoningEffort } from '@/lib/reasoning-effort';

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
  /**
   * How hard this model should think before answering.
   *
   * Per-model rather than per-provider because the available levels are a
   * property of the model, not of the endpoint: one API key serves both a
   * reasoning model and one that rejects the setting outright. Absent means
   * `'provider-default'` — the field is omitted from the request — so configs
   * written before this existed keep their exact behaviour. See
   * `lib/reasoning-effort.ts`.
   */
  reasoningEffort?: ReasoningEffort;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKey: string;
  models: ModelConfig[];
}

/**
 * Which key combination sends a chat message from the input box.
 * - `'enter'`: Enter (with no modifier) sends; any modifier+Enter (Shift,
 *   Ctrl/Cmd, Alt/Option) inserts a newline.
 * - `'meta-enter'`: any modifier+Enter sends — Ctrl/Alt/Shift on Windows,
 *   ⌘/⌥/⇧ on macOS (the name is a loose shorthand for "a modifier key");
 *   plain Enter inserts a newline.
 */
export type SendKey = 'enter' | 'meta-enter';

/**
 * A user-selectable colour theme.
 *
 * `'system'` is a *preference*, not a palette — it resolves to one of the
 * concrete themes at apply time based on `prefers-color-scheme`. Every other
 * member maps 1:1 to a token block in `assets/globals.css`.
 *
 * Adding a theme is a two-step change: extend this union, then register it in
 * `THEMES` (see `lib/theme.ts`) — TypeScript will flag every place that needs
 * updating, including the i18n label map.
 */
export type Theme = 'light' | 'dark' | 'midnight' | 'system';

/**
 * The subset of {@link Theme} that names an actual palette. `'system'` is
 * excluded because it always resolves to one of these before being applied.
 */
export type ResolvedTheme = Exclude<Theme, 'system'>;

export interface UISettings {
  language: 'en' | 'zh';
  theme: Theme;
  /** Maximum number of side-by-side chat panels (1–3). Default is 1. */
  maxSplitPanels: 1 | 2 | 3;
  /** Which key combination sends a chat message. Default is Enter. */
  sendKey: SendKey;
  /**
   * Character count at which a paste into the composer becomes a text
   * attachment instead of inline text. `0` disables it, `1` attaches every
   * paste. See `lib/paste-threshold.ts`.
   */
  pasteThreshold: number;
  /**
   * Maximum number of tool-loop steps one assistant turn may run. `0` means no
   * cap (the default); a cap is at least 10. See `lib/max-steps.ts`.
   */
  maxSteps: number;
}

/**
 * A text attachment dragged from external sources (web pages, etc.).
 * Can be plain text, HTML, or a file reference. Sent as a separate text content part.
 */
export interface TextAttachment {
  id: string;
  /**
   * The semantic kind of attachment:
   * - 'text': plain text or HTML content (default if omitted for backwards compat)
   * - 'file-ref': a reference to a file stored in the extension's file system
   * - 'page-context': the identity (tabId/title/url) of the page a quick action
   *   was fired from. See `lib/page-context.ts`.
   */
  kind?: 'text' | 'file-ref' | 'page-context';
  /** The content type: 'text/plain' or 'text/html' */
  mediaType: 'text/plain' | 'text/html';
  /** The actual text/html content, or `[file: name]` for file-ref kind */
  content: string;
  /** A short preview label (first N chars, or the file name for file-ref) */
  preview: string;
  /** Optional display label override (e.g. "File" for file references) */
  label?: string;
}

/** User-authored system instructions prepended to every conversation. */
export interface SystemPromptSettings {
  /** Whether to send `prompt` at all. */
  enabled: boolean;
  /** Raw system prompt text. Sent verbatim, no templating. */
  prompt: string;
  /** When true, prepend `CurrentTime: <local time>` to the resolved prompt. */
  injectCurrentTime?: boolean;
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
  /**
   * Metadata for text/HTML attachments dragged from external sources.
   * Used by the UI to render attachments as distinct cards rather than inline text.
   * The actual content is also stored in `parts` as text parts for sending to the model.
   */
  textAttachments?: TextAttachment[];
  /**
   * Set on an assistant turn that never reached its natural end — the user hit
   * stop, or the panel was torn down (side panel closed, split panel removed)
   * while the reply was still streaming.
   *
   * Such a turn is persisted deliberately, because losing a half-written answer
   * is worse than showing a truncated one. The flag exists so the UI can say so:
   * without it a truncated reply is indistinguishable from a complete one, and
   * the user cannot tell whether the model actually finished its thought.
   */
  interrupted?: boolean;
  /**
   * Why an `interrupted` turn stopped, when it was not the user's doing.
   *
   * Absent means the ordinary case the flag was introduced for: the user hit
   * stop, or the panel was torn down. `'step-limit'` is the one cause the user
   * did not choose per-turn but *did* configure, so it gets its own notice —
   * telling them the reply was cut by their own step cap is actionable, whereas
   * the generic "interrupted" label would send them looking for a failure that
   * never happened. See `lib/max-steps.ts`.
   */
  stopReason?: 'step-limit';
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
  /**
   * The resolved system prompt snapshot for this conversation.
   * Generated once when the conversation starts; reused on subsequent messages
   * so that time-injected prompts stay stable and provider caching works.
   */
  systemPrompt?: string;
}

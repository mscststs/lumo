import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  streamText,
  readUIMessageStream,
  isStepCount,
  isToolUIPart,
  convertToModelMessages,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
  type ToolSet,
  type UIMessage,
} from 'ai';
import type { ProviderConfig, ModelConfig, ChatMessagePart } from '@/types';
import { normalizeProviderType } from '@/lib/provider-type';
import { mcpRegistry } from '@/lib/mcp';

/**
 * Cap on tool-loop iterations. Matches the AI SDK's default agent step limit.
 * Keeps the manual loop below bounded even if the model keeps calling tools.
 */
const MAX_STEPS = 20;

/** Placeholder used when image payloads are stripped from the model prompt. */
const IMAGE_OMITTED = '[image data omitted for model context]';

/** Compact a string by replacing base64 image data-URLs with a placeholder. */
export function compactifyImageData(text: string): string {
  if (!text.includes('data:image/')) return text;
  return text.replace(/data:image\/[^;,)]+;base64,[A-Za-z0-9+/=]+/g, '[image]');
}

/** Detect whether a tool result output carries image content. */
export function toolResultOutputHasImage(output: { type?: string; value?: unknown }): boolean {
  if (output.type === 'content') {
    return (output.value as Array<{ type?: string; mediaType?: string }>).some(
      (part) => part.type === 'file' && part.mediaType?.startsWith('image'),
    );
  }
  const raw = output.value;
  if (raw == null) return false;
  if (typeof raw === 'string') return raw.includes('data:image/');
  if (typeof raw === 'object') {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content.some((part) => {
        const p = part as { type?: string; data?: unknown; text?: string };
        return (
          p.type === 'image' ||
          (typeof p.text === 'string' && p.text.includes('data:image/'))
        );
      });
    }
    return JSON.stringify(raw).includes('data:image/');
  }
  return false;
}

/**
 * Strip image payloads from a tool result output so the model prompt never
 * carries giant base64 blobs. Text content (e.g. a screenshot caption) is kept.
 */
export function sanitizeToolOutput<T extends { type?: string; value?: unknown }>(output: T): T {
  if (!toolResultOutputHasImage(output)) return output;

  if (output.type === 'content') {
    const textParts = (output.value as Array<{ type?: string; text?: string }>).filter(
      (part) => part.type === 'text' && typeof part.text === 'string',
    );
    if (textParts.length > 0) {
      return { ...output, value: textParts } as T;
    }
    return { ...output, type: 'text', value: IMAGE_OMITTED } as T;
  }

  if (output.type === 'json') {
    const value = output.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
      if (Array.isArray(content)) {
        const textContent = content
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => compactifyImageData(part.text as string))
          .filter((text) => text.length > 0);
        return {
          ...output,
          value: {
            ...(value as object),
            content:
              textContent.length > 0
                ? textContent.map((text) => ({ type: 'text', text }))
                : [{ type: 'text', text: IMAGE_OMITTED }],
          },
        } as T;
      }
    }
    return { ...output, value: compactifyImageData(JSON.stringify(value)) } as T;
  }

  if (typeof output.value === 'string') {
    return { ...output, value: compactifyImageData(output.value) } as T;
  }
  return { ...output, value: IMAGE_OMITTED } as T;
}

/**
 * Apply `sanitizeToolOutput` to every tool result in a set of model messages.
 * Used both for replayed history and for each freshly executed step.
 */
export function sanitizeToolResultImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const output = sanitizeToolOutput(part.output);
      if (output === part.output) return part;
      changed = true;
      return { ...part, output } as (typeof message.content)[number];
    });
    return changed ? { ...message, content } : message;
  });
}

/** Collect image content parts from the tool-result parts of a UI part list. */
export function extractImagesFromParts(parts: ChatMessagePart[]): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    const output = (part as { output?: unknown }).output;
    if (!output || typeof output !== 'object') continue;
    const content = (output as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const p = item as { type?: string; data?: unknown; mimeType?: unknown };
      if (p.type === 'image' && typeof p.data === 'string' && typeof p.mimeType === 'string') {
        images.push({ data: p.data, mimeType: p.mimeType });
      }
    }
  }
  return images;
}

/**
 * Build the synthetic user message that carries tool-produced images back to
 * the model. Only lives in the in-memory model prompt — it is never persisted
 * to the conversation or surfaced in the UI.
 */
export function buildImageUserMessage(images: Array<{ data: string; mimeType: string }>): ModelMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'The assistant used a browser tool that captured the following image(s). Use them for your response:',
      },
      ...images.map(({ data, mimeType }) => ({
        type: 'file' as const,
        mediaType: mimeType,
        data: { type: 'data' as const, data },
      })),
    ],
  };
}

/**
 * A model plus the provider-specific request options it needs.
 *
 * `providerOptions` is not cosmetic for the Responses API: with the SDK default
 * `store: true` and no `previousResponseId`, prior assistant/reasoning parts are
 * replayed as `{ type: 'item_reference', id }`, which requires the server to
 * still hold those items. Forcing `store: false` makes the SDK inline the real
 * content (and auto-request `reasoning.encrypted_content`) instead.
 */
export interface ResolvedModel {
  model: LanguageModel;
  /** `ProviderMetadata` is the request-side provider options bag in ai v7. */
  providerOptions?: ProviderMetadata;
}

export function createProvider(
  provider: ProviderConfig,
  model: ModelConfig,
): ResolvedModel {
  const type = normalizeProviderType(provider.type);

  if (type === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });
    return { model: anthropic(model.modelId) };
  }

  const openai = createOpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl || 'https://api.openai.com/v1',
  });

  if (type === 'openai-responses') {
    // `openai(id)` is the Responses model in @ai-sdk/openai v4.
    return {
      model: openai.responses(model.modelId),
      providerOptions: {
        openai: {
          // Stateless: never emit `item_reference` for replayed history.
          store: false,
          // Needed to keep reasoning readable once it is inlined instead of
          // referenced; ignored by non-reasoning models.
          reasoningSummary: 'auto',
        },
      },
    };
  }

  // `openai-chat` → /chat/completions, the portable shape every
  // "OpenAI compatible" gateway implements.
  return { model: openai.chat(model.modelId) };
}

export interface ChatStreamOptions {
  provider: ProviderConfig;
  model: ModelConfig;
  /**
   * Conversation history as UI messages. Converted to the model prompt inside
   * `chatStream` so the exact same tool set drives both the conversion and the
   * request (see `enableTools`).
   */
  messages: UIMessage[];
  /** Optional system instructions prepended to the prompt. */
  system?: string;
  /**
   * Called on every stream update with the full, ordered part list of the
   * assistant message. Text and tool parts arrive interleaved in the order the
   * model produced them.
   */
  onUpdate: (parts: ChatMessagePart[]) => void;
  onFinish: (parts: ChatMessagePart[]) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  /** Whether to include MCP tools in this request */
  enableTools?: boolean;
  /** Conversation ID for the current stream (passed to tools for file association) */
  conversationId?: string;
}

export async function chatStream({
  provider,
  model,
  messages,
  system,
  onUpdate,
  onFinish,
  onError,
  signal,
  enableTools = true,
  conversationId,
}: ChatStreamOptions) {
  let latestParts: ChatMessagePart[] = [];
  // `readUIMessageStream` reports errors via its `onError` callback and then
  // closes the stream normally, so guard the terminal callbacks to make sure
  // exactly one of onFinish/onError runs (otherwise the message is saved twice).
  let settled = false;

  const finishOnce = (parts: ChatMessagePart[]) => {
    if (settled) return;
    settled = true;
    onFinish(parts);
  };

  const failOnce = (error: unknown) => {
    if (settled) return;
    settled = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  try {
    const { model: aiModel, providerOptions } = createProvider(provider, model);

    // Gather tools from all connected MCP servers (with stream-specific context)
    const tools: ToolSet = enableTools
      ? mcpRegistry.getAllAITools({ conversationId })
      : {};
    const trimmedSystem = system?.trim();

    // Rebuild the model prompt from history. `tools` resolves each stored tool
    // result against its definition (applying `toModelOutput`), and the
    // sanitizer strips stale image payloads so old screenshots can never bloat
    // the context again.
    const modelMessages = sanitizeToolResultImages(
      await convertToModelMessages(messages, {
        tools,
        // A tool call left dangling by an aborted stream would otherwise throw.
        ignoreIncompleteToolCalls: true,
      }),
    );

    const parts = await runAgentLoop({
      model: aiModel,
      providerOptions,
      tools,
      system: trimmedSystem,
      messages: modelMessages,
      signal,
      onUpdate: (updatedParts) => {
        latestParts = updatedParts;
        onUpdate(updatedParts);
      },
      onError: failOnce,
    });
    latestParts = parts;

    finishOnce(latestParts);
  } catch (error) {
    if (isAbort(error)) {
      // Keep whatever was streamed before the user hit stop.
      finishOnce(latestParts);
      return;
    }
    failOnce(error);
  }
}

export interface RunAgentLoopOptions {
  model: LanguageModel;
  providerOptions?: ProviderMetadata;
  tools?: ToolSet;
  system?: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  /** Called on every stream update with the full, ordered part list. */
  onUpdate?: (parts: ChatMessagePart[]) => void;
  /** Called when a model stream reports an error. */
  onError?: (error: unknown) => void;
}

/**
 * Run the tool agent loop step by step.
 *
 * A single `streamText` call (with `stopWhen: isStepCount(1)`) drives one model
 * round-trip; the loop below owns continuation so it can:
 * 1. strip image payloads out of tool results fed back to the model, and
 * 2. re-inject them as a synthetic user message — the only way Chat-Completions
 *    models can "see" tool-produced images. The same uniform path also works
 *    for Anthropic and OpenAI Responses.
 */
export async function runAgentLoop({
  model,
  providerOptions,
  tools = {},
  system,
  messages,
  signal,
  onUpdate,
  onError,
}: RunAgentLoopOptions): Promise<ChatMessagePart[]> {
  const hasTools = Object.keys(tools).length > 0;
  const trimmedSystem = system?.trim();
  let modelMessages = sanitizeToolResultImages(messages);
  let latestParts: ChatMessagePart[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    // `readUIMessageStream` reports stream errors via `onError` and then closes
    // normally, so flag it and stop instead of spending another model request.
    let errored = false;
    const handleError = (error: unknown) => {
      errored = true;
      onError?.(error);
    };

    const result = streamText({
      model,
      messages: modelMessages,
      abortSignal: signal,
      ...(trimmedSystem ? { system: trimmedSystem } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      // A single step per iteration — this loop drives continuation so it can
      // strip/inject images between steps.
      ...(hasTools ? { tools, stopWhen: isStepCount(1) } : {}),
    });

    // `textStream` would drop every tool/reasoning chunk, so consume the full
    // stream as UI message chunks and let the SDK assemble the ordered parts.
    const uiStream = readUIMessageStream<UIMessage>({
      stream: result.toUIMessageStream({
        sendReasoning: true,
        // Defaults to masking errors as "An error occurred." to avoid leaking
        // server details; here the model call is the user's own, so show it.
        onError: (error) => (error instanceof Error ? error.message : String(error)),
      }),
      onError: handleError,
    });

    // Accumulate this step's parts onto everything streamed before it.
    const stepStartIndex = latestParts.length;
    for await (const uiMessage of uiStream) {
      const stepParts = uiMessage.parts as ChatMessagePart[];
      latestParts = [...latestParts.slice(0, stepStartIndex), ...stepParts];
      onUpdate?.(latestParts);
    }

    if (errored) break;

    const responseMeta = await result.response;
    const stepMessages = responseMeta.messages;

    // Feed the step's assistant + tool messages back, minus image payloads.
    modelMessages = [...modelMessages, ...sanitizeToolResultImages(stepMessages)];

    // Re-inject tool-produced images as a synthetic user message.
    const images = extractImagesFromParts(latestParts.slice(stepStartIndex));
    if (images.length > 0) {
      modelMessages.push(buildImageUserMessage(images));
    }

    // `isLoopFinished()` semantics: keep looping while the model still issues
    // tool calls.
    const hasPendingToolCalls = stepMessages.some(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool-call'),
    );
    if (!hasPendingToolCalls) break;
  }

  return latestParts;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

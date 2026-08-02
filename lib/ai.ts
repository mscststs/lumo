import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  streamText,
  readUIMessageStream,
  isLoopFinished,
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
    const hasTools = Object.keys(tools).length > 0;
    const trimmedSystem = system?.trim();

    // `tools` also matters here: it resolves each stored tool part against its
    // definition so the tool's own `toModelOutput` is applied. Omitting it makes
    // every past tool result degrade into a generic JSON dump.
    const modelMessages: ModelMessage[] = await convertToModelMessages(messages, {
      tools,
      // A tool call left dangling by an aborted stream would otherwise throw.
      ignoreIncompleteToolCalls: true,
    });

    const result = streamText({
      model: aiModel,
      messages: modelMessages,
      abortSignal: signal,
      ...(trimmedSystem ? { system: trimmedSystem } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      // `isLoopFinished()` never stops the loop proactively — it relies on the
      // model's natural termination (stop emitting tool calls). Without an
      // explicit `stopWhen`, the SDK defaults to `isStepCount(1)` which kills
      // the agent loop after a single tool round-trip.
      ...(hasTools ? { tools, stopWhen: isLoopFinished() } : {}),
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
      onError: failOnce,
    });

    for await (const uiMessage of uiStream) {
      latestParts = uiMessage.parts as ChatMessagePart[];
      onUpdate(latestParts);
    }

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

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

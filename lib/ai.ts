import { createOpenResponses } from '@ai-sdk/open-responses';
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
import type { ProviderConfig, ProviderType, ModelConfig, ChatMessagePart, TokenUsageStats, TokenUsageStep } from '@/types';
import { normalizeProviderType } from '@/lib/provider-type';
import {
  isUnifiedEffort,
  resolveReasoningEffort,
  type ReasoningEffort,
  type UnifiedReasoningEffort,
} from '@/lib/reasoning-effort';
import { toError } from '@/lib/provider-error';
import { repairToolCall } from '@/lib/tool-call-repair';
import { mcpRegistry } from '@/lib/mcp';
import { DEFAULT_MAX_STEPS, stepAllowed } from '@/lib/max-steps';
import { projectImagesForNonVision, buildImageFallbackMessage, filterToolsByVision, isOcrAvailable } from '@/lib/image-projection';

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

    // AI SDK wraps tool outputs in one of several shapes depending on whether
    // `toModelOutput` exists on the tool and whether the raw result was a string:
    //
    // 1. Direct: { content: [{ type: 'image', data, mimeType }, ...] }
    //    (Legacy / direct assignment in unit tests)
    //
    // 2. JSON-wrapped (no toModelOutput): { type: 'json', value: { content: [...] } }
    //    SDK's `createToolModelOutput` wraps non-string results this way.
    //
    // 3. Content-wrapped (with toModelOutput that returns images):
    //    { type: 'content', value: [{ type: 'file', mediaType, data: { type: 'data', data } }, ...] }
    //    Our `mcpToModelOutput` produces this for image-bearing results.

    const typed = output as { type?: string; value?: unknown; content?: unknown };

    // Case 1: direct content array on output
    if (Array.isArray(typed.content)) {
      extractFromContentArray(typed.content, images);
      continue;
    }

    // Case 2: JSON-wrapped — unwrap .value and look for .content inside
    if (typed.type === 'json' && typed.value && typeof typed.value === 'object') {
      const inner = typed.value as { content?: unknown };
      if (Array.isArray(inner.content)) {
        extractFromContentArray(inner.content, images);
      }
      continue;
    }

    // Case 3: content-wrapped by toModelOutput — value is an array of parts
    if (typed.type === 'content' && Array.isArray(typed.value)) {
      for (const item of typed.value) {
        const p = item as { type?: string; mediaType?: string; data?: { type?: string; data?: string } };
        if (p.type === 'file' && p.mediaType?.startsWith('image/') && p.data?.type === 'data' && typeof p.data.data === 'string') {
          images.push({ data: p.data.data, mimeType: p.mediaType });
        }
      }
    }
  }
  return images;
}

/** Extract images from a raw content array (CallToolResult format). */
function extractFromContentArray(
  content: unknown[],
  images: Array<{ data: string; mimeType: string }>,
): void {
  for (const item of content) {
    const p = item as { type?: string; data?: unknown; mimeType?: unknown };
    if (p.type === 'image' && typeof p.data === 'string' && typeof p.mimeType === 'string') {
      images.push({ data: p.data, mimeType: p.mimeType });
    }
  }
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
  /**
   * The unified reasoning level for this request, or `undefined` to leave the
   * setting off entirely.
   *
   * Only levels the unified setting can spell reach this field. Passing them here
   * rather than as provider options is what buys the per-model corrections we
   * would otherwise have to reproduce: the SDK's Anthropic adapter turns `high`
   * into `output_config.effort` on models built for it and into a derived
   * `thinking.budget_tokens` on models that are not, using a capability table we
   * have no access to. A level with no unified spelling — see
   * `PROVIDER_ONLY_EFFORTS` — is written into `providerOptions` by the branch for
   * its own provider instead.
   */
  reasoning?: UnifiedReasoningEffort;
}

/**
 * Provider options carrying a level the unified setting cannot express.
 *
 * Split per provider because the field is genuinely different in each protocol,
 * which is also why this cannot live in shared code: OpenAI takes an effort
 * string, Anthropic takes an `output_config.effort` *plus* a thinking block. The
 * levels that land here only exist on models new enough to implement the
 * effort-style API, so mirroring what the SDK sends for `xhigh` on those same
 * models — adaptive thinking, summarised — is what keeps the reasoning stream
 * visible instead of silently dropping it one notch above `xhigh`.
 */
function providerOnlyReasoning(
  type: ProviderType,
  effort: Exclude<ReasoningEffort, UnifiedReasoningEffort>,
): ProviderMetadata {
  return type === 'anthropic'
    ? { anthropic: { effort, thinking: { type: 'adaptive', display: 'summarized' } } }
    : type === 'openai-responses'
      ? { 'open-responses': { reasoningEffort: effort } }
      : { openai: { reasoningEffort: effort } };
}

export function createProvider(
  provider: ProviderConfig,
  model: ModelConfig,
): ResolvedModel {
  const type = normalizeProviderType(provider.type);
  const effort = resolveReasoningEffort(model.reasoningEffort);
  // Either the level rides the unified setting, or it is this provider's own
  // spelling of one the unified setting has no word for. Never both.
  const reasoning = effort && isUnifiedEffort(effort) ? { reasoning: effort } : {};
  const reasoningOptions =
    effort && !isUnifiedEffort(effort) ? providerOnlyReasoning(type, effort) : undefined;

  if (type === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });
    return {
      model: anthropic(model.modelId),
      ...reasoning,
      ...(reasoningOptions ? { providerOptions: reasoningOptions } : {}),
    };
  }

  const openai = createOpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl || 'https://api.openai.com/v1',
  });

  if (type === 'openai-responses') {
    const openResponses = createOpenResponses({
      name: 'open-responses',
      url: `${provider.baseUrl || 'https://api.openai.com/v1'}/responses`,
      apiKey: provider.apiKey,
    });
    return {
      model: openResponses(model.modelId),
      ...reasoning,
      providerOptions: {
        openai: {
          store: false,
          ...(reasoningOptions?.['open-responses'] as { reasoningEffort?: string } | undefined),
        },
        'open-responses': {
          ...reasoningOptions?.['open-responses'],
        },
      },
    };
  }

  // `openai-chat` → /chat/completions, the portable shape every
  // "OpenAI compatible" gateway implements.
  return {
    model: openai.chat(model.modelId),
    ...reasoning,
    ...(reasoningOptions ? { providerOptions: reasoningOptions } : {}),
  };
}

/**
 * A resumable snapshot of an interrupted `chatStream` run.
 *
 * `modelMessages` bypasses `convertToModelMessages`, so it is only valid for the
 * exact conversation and provider/model that produced it — the wire shape of
 * tool calls differs per provider. `fingerprint` carries that identity so a
 * stale snapshot (e.g. the user switched models before retrying) is discarded
 * rather than sent to an incompatible endpoint.
 */
export interface ResumeState extends AgentLoopCheckpoint {
  fingerprint: string;
}

/**
 * Identity a `ResumeState` must match to be safely replayed.
 */
export function resumeFingerprint({
  conversationId,
  provider,
  model,
  messageCount,
  ocrAvailable = false,
}: {
  conversationId: string;
  provider: ProviderConfig;
  model: ModelConfig;
  /** Guards against replaying onto a conversation that has since grown. */
  messageCount: number;
  /**
   * Whether OCR is available (enabled + configured). Part of the identity for
   * the same reason vision is: it decides whether image-producing tools such as
   * `page_screenshot` are in the tool set, so a checkpoint taken with OCR on
   * must not be resumed after it is turned off (and vice versa).
   */
  ocrAvailable?: boolean;
}): string {
  return [
    conversationId,
    provider.id,
    normalizeProviderType(provider.type),
    provider.baseUrl ?? '',
    model.modelId,
    // Part of the identity for the same reason `modelId` is: the effort changes
    // the request a checkpoint would be replayed into, and on Anthropic it even
    // decides whether thinking blocks are present at all — so a snapshot taken
    // under one level must not be resumed under another.
    resolveReasoningEffort(model.reasoningEffort) ?? '',
    // Vision capability changes how images are projected into the prompt, so a
    // checkpoint taken under a vision model must not be resumed under a non-vision
    // one (which would carry raw image data the model cannot parse).
    model.isVision ? 'v1' : 'v0',
    // OCR availability changes which tools are exposed, so a checkpoint taken
    // under one OCR state must not be replayed under another.
    ocrAvailable ? 'ocr1' : 'ocr0',
    messageCount,
  ].join('\u0000');
}

/**
 * Why an assistant turn stopped producing steps.
 *
 * The distinction exists because only one of these is the model deciding it is
 * done. The others leave work unfinished, and a caller that cannot tell them
 * apart has to treat a truncated turn as a complete one — which is exactly the
 * failure this type was added to remove: the loop used to fall out of its step
 * cap through the same `return` as a natural finish, so a turn cut off mid-task
 * was saved, rendered and reported as if the model had answered.
 */
export type StopReason =
  /** The model answered without calling tools — its own natural end. */
  | 'finished'
  /** The configured step cap ran out while tool calls were still pending. */
  | 'step-limit'
  /** A provider or stream error ended the run. */
  | 'error'
  /** The user hit stop, or the panel was torn down mid-stream. */
  | 'aborted';

export interface ChatStreamOptions {
  provider: ProviderConfig;
  model: ModelConfig;
  /** Whether the model supports vision (image inputs). */
  isVision?: boolean;
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
  onFinish: (parts: ChatMessagePart[], stoppedReason: StopReason, usage?: TokenUsageStats) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  /** Whether to include MCP tools in this request */
  enableTools?: boolean;
  /** Conversation ID for the current stream (passed to tools for file association) */
  conversationId?: string;
  /**
   * Cap on tool-loop steps for this turn. `0` (the default) means no cap. Read
   * from the user's UI settings per turn, so changing it takes effect on the
   * next message rather than on the next reload. See `lib/max-steps.ts`.
   */
  maxSteps?: number;
  /**
   * Resume an interrupted run from its last completed step instead of replaying
   * the whole conversation. Ignored when the fingerprint does not match.
   */
  resume?: ResumeState;
  /** Emits a resume checkpoint after every completed step. */
  onStepComplete?: (checkpoint: AgentLoopCheckpoint) => void;
  /** Called after each step with the cumulative token usage so far. */
  onUsage?: (usage: TokenUsageStats) => void;
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
  isVision = true,
  conversationId,
  maxSteps = DEFAULT_MAX_STEPS,
  resume,
  onStepComplete,
  onUsage,
}: ChatStreamOptions) {
  // Seed with the resumed parts so an abort or a second failure still reports
  // everything streamed across attempts, not just the current one.
  let latestParts: ChatMessagePart[] = resume ? [...resume.parts] : [];
  // `readUIMessageStream` reports errors via its `onError` callback and then
  // closes the stream normally, so guard the terminal callbacks to make sure
  // exactly one of onFinish/onError runs (otherwise the message is saved twice).
  let settled = false;

  const finishOnce = (parts: ChatMessagePart[], stoppedReason: StopReason, usage?: TokenUsageStats) => {
    if (settled) return;
    settled = true;
    onFinish(parts, stoppedReason, usage);
  };

  const failOnce = (error: unknown) => {
    if (settled) return;
    settled = true;
    onError(toError(error));
  };

  try {
    const { model: aiModel, providerOptions, reasoning } = createProvider(provider, model);

    // Gather tools from all connected MCP servers (with stream-specific context).
    // A non-vision model still gets image-producing tools (e.g. page_screenshot)
    // when OCR is enabled: the loop OCRs their output before it reaches the model.
    const tools: ToolSet = enableTools
      ? filterToolsByVision(
          mcpRegistry.getAllAITools({ conversationId }),
          isVision || (await isOcrAvailable()),
        )
      : {};
    const trimmedSystem = system?.trim();

    // Resuming replays the checkpoint verbatim: it is already a model prompt
    // with sanitized tool results, so re-deriving it from history would both
    // waste work and lose the synthetic image messages the loop injected.
    let modelMessages = resume
      ? resume.modelMessages
      : sanitizeToolResultImages(
          await convertToModelMessages(messages, {
            tools,
            // A tool call left dangling by an aborted stream would otherwise throw.
            ignoreIncompleteToolCalls: true,
          }),
        );

    // For non-vision models, project images to text (OCR or placeholder).
    if (!isVision && !resume) {
      modelMessages = await projectImagesForNonVision(modelMessages, signal);
    }

    const { parts, stoppedReason, usage } = await runAgentLoop({
      model: aiModel,
      providerOptions,
      reasoning,
      tools,
      system: trimmedSystem,
      messages: modelMessages,
      initialParts: resume?.parts,
      maxSteps,
      isVision,
      signal,
      onUpdate: (updatedParts) => {
        latestParts = updatedParts;
        onUpdate(updatedParts);
      },
      onError: failOnce,
      onStepComplete,
      onUsage,
    });
    latestParts = parts;

    finishOnce(latestParts, stoppedReason, usage);
  } catch (error) {
    if (isAbort(error)) {
      // Keep whatever was streamed before the user hit stop.
      finishOnce(latestParts, 'aborted');
      return;
    }
    failOnce(error);
  }
}

export interface RunAgentLoopOptions {
  model: LanguageModel;
  providerOptions?: ProviderMetadata;
  /**
   * Unified reasoning level for every step of this run. Omitted from the request
   * when absent, which is what a model left on the provider default resolves to,
   * and also what a level only its own provider can spell resolves to — that one
   * travels in `providerOptions` instead.
   */
  reasoning?: UnifiedReasoningEffort;
  tools?: ToolSet;
  system?: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  /** Whether the model supports vision. Controls image re-injection. */
  isVision?: boolean;
  /** Parts already streamed by earlier steps, when resuming a failed run. */
  initialParts?: ChatMessagePart[];
  /** Cap on iterations. `0` (the default) means no cap. See `lib/max-steps.ts`. */
  maxSteps?: number;
  /** Called on every stream update with the full, ordered part list. */
  onUpdate?: (parts: ChatMessagePart[]) => void;
  /** Called when a model stream reports an error. */
  onError?: (error: unknown) => void;
  /**
   * Called once per fully completed step with the exact prompt the *next* step
   * would run with. This is the resume checkpoint: it is emitted after tool
   * results and tool-produced images have been folded into the prompt, so
   * replaying it reproduces the loop state without re-running the step.
   */
  onStepComplete?: (checkpoint: AgentLoopCheckpoint) => void;
  /**
   * Called after each step with the cumulative token usage so far.
   * Lets callers track costs in real time without awaiting the full result.
   */
  onUsage?: (usage: TokenUsageStats) => void;
}

/** Outcome of a `runAgentLoop` run: what it produced, and why it stopped. */
export interface AgentLoopResult {
  parts: ChatMessagePart[];
  /** Never `'aborted'` — an abort unwinds as a thrown error, not a return. */
  stoppedReason: Exclude<StopReason, 'aborted'>;
  /** Cumulative token usage across all steps in this run. */
  usage: TokenUsageStats;
}

/** Snapshot of the agent loop between two steps. */
export interface AgentLoopCheckpoint {
  /** Full model prompt as of the end of the completed step. */
  modelMessages: ModelMessage[];
  /** Every UI part streamed up to and including the completed step. */
  parts: ChatMessagePart[];
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
 *
 * Owning continuation also means owning the step cap, which is why the outcome
 * is returned rather than just the parts: hitting the cap leaves tool calls
 * pending, and the caller has to be able to say so.
 */
export async function runAgentLoop({
  model,
  providerOptions,
  reasoning,
  tools = {},
  system,
  messages,
  signal,
  isVision = true,
  initialParts,
  maxSteps = DEFAULT_MAX_STEPS,
  onUpdate,
  onError,
  onStepComplete,
  onUsage,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const hasTools = Object.keys(tools).length > 0;
  const trimmedSystem = system?.trim();
  let modelMessages = sanitizeToolResultImages(messages);
  // Seeding with the parts already streamed lets a resumed run keep appending
  // instead of restarting the part list, so the UI never loses earlier steps.
  let latestParts: ChatMessagePart[] = initialParts ? [...initialParts] : [];

  // Cumulative token usage across all steps.
  const usageSteps: TokenUsageStep[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalReasoning = 0;

  /** Build a cumulative usage snapshot from the running totals. */
  const buildUsage = (): TokenUsageStats => ({
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens: totalInput + totalOutput,
    ...(totalCacheRead > 0 ? { cacheReadTokens: totalCacheRead } : {}),
    ...(totalCacheWrite > 0 ? { cacheWriteTokens: totalCacheWrite } : {}),
    ...(totalReasoning > 0 ? { reasoningTokens: totalReasoning } : {}),
    steps: [...usageSteps],
  });

  for (let step = 0; stepAllowed(step, maxSteps); step++) {
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
      // Spread, so a default-configured model leaves the key off the call object
      // entirely. The SDK ignores an explicit `undefined` too, but keeping it
      // absent is what makes "provider default" verifiable from the request.
      ...(reasoning ? { reasoning } : {}),
      // A single step per iteration — this loop drives continuation so it can
      // strip/inject images between steps.
      //
      // `repairToolCall` recovers arguments a gateway mangled in transit (see
      // `lib/tool-call-repair.ts`). Without it the SDK turns such a call into a
      // `tool-error`, which spends one of this loop's steps on a call the model
      // meant correctly.
      ...(hasTools ? { tools, stopWhen: isStepCount(1), repairToolCall } : {}),
    });

    // `textStream` would drop every tool/reasoning chunk, so consume the full
    // stream as UI message chunks and let the SDK assemble the ordered parts.
    const uiStream = readUIMessageStream<UIMessage>({
      stream: result.toUIMessageStream({
        sendReasoning: true,
        // Defaults to masking errors as "An error occurred." to avoid leaking
        // server details; here the model call is the user's own, so show it.
        // Providers may emit non-`Error` frames, so unwrap rather than
        // stringify — `String(frame)` would collapse to "[object Object]".
        onError: (error) => toError(error).message,
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

    if (errored) return { parts: latestParts, stoppedReason: 'error', usage: buildUsage() };

    // Collect token usage for this step.
    const stepUsage = await result.usage;
    const stepCacheRead = stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
    const stepCacheWrite = stepUsage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const stepReasoningTokens = stepUsage.outputTokenDetails?.reasoningTokens ?? 0;
    const stepInputTokens = stepUsage.inputTokens ?? 0;
    const stepOutputTokens = stepUsage.outputTokens ?? 0;

    totalInput += stepInputTokens;
    totalOutput += stepOutputTokens;
    totalCacheRead += stepCacheRead;
    totalCacheWrite += stepCacheWrite;
    totalReasoning += stepReasoningTokens;

    usageSteps.push({
      step,
      inputTokens: stepInputTokens,
      outputTokens: stepOutputTokens,
      totalTokens: stepInputTokens + stepOutputTokens,
      ...(stepCacheRead > 0 ? { cacheReadTokens: stepCacheRead } : {}),
      ...(stepCacheWrite > 0 ? { cacheWriteTokens: stepCacheWrite } : {}),
      ...(stepReasoningTokens > 0 ? { reasoningTokens: stepReasoningTokens } : {}),
    });

    onUsage?.(buildUsage());

    const responseMeta = await result.response;
    const stepMessages = responseMeta.messages;

    // Feed the step's assistant + tool messages back, minus image payloads.
    modelMessages = [...modelMessages, ...sanitizeToolResultImages(stepMessages)];

    // Re-inject tool-produced images as a synthetic user message.
    const images = extractImagesFromParts(latestParts.slice(stepStartIndex));
    if (images.length > 0) {
      if (isVision) {
        modelMessages.push(buildImageUserMessage(images));
      } else {
        // Non-vision model: OCR or placeholder for tool-produced images.
        const fallback = await buildImageFallbackMessage(images, signal);
        modelMessages.push(fallback);
      }
    }

    // `isLoopFinished()` semantics: keep looping while the model still issues
    // tool calls.
    const hasPendingToolCalls = stepMessages.some(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool-call'),
    );
    if (!hasPendingToolCalls) return { parts: latestParts, stoppedReason: 'finished', usage: buildUsage() };

    // Checkpoint *after* image injection, so the snapshot is byte-for-byte the
    // prompt the next iteration is about to send. Emitted only when the loop
    // continues, which makes "a checkpoint exists" mean "work remains".
    onStepComplete?.({
      modelMessages: [...modelMessages],
      parts: [...latestParts],
    });
  }

  // Falling out of the loop means the cap ran out with tool calls still pending.
  // Every other way to leave it returns from inside, so this cannot be reached
  // by a turn the model actually finished.
  return { parts: latestParts, stoppedReason: 'step-limit', usage: buildUsage() };
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

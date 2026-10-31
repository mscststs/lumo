import type {
  ChatMessage,
  ChatMessagePart,
  Conversation,
  ConversationCompaction,
  ModelConfig,
  TextAttachment,
  TokenUsageStats,
} from '@/types';
import { normalizeMessage } from '@/lib/message-parts';
import {
  IMAGE_CHARS,
  estimateCharsToTokens,
  measureUIPartsChars,
  type ImageAccounting,
} from '@/lib/prompt-size';

/**
 * Context-window occupancy for the composer's ring.
 *
 * Mirrors how the model prompt is actually assembled. The *last* agent-loop
 * step's usage is the authoritative size of a real prompt — it already includes
 * the system prompt, tool schemas and every message up to that point — so only
 * what came after it has to be estimated. Summing `inputTokens` across a turn
 * would instead count the same history once per tool step, which is the billing
 * view (`TokenUsageStats`) and overstates a multi-step turn several times over.
 *
 * The heuristic only ever measures text. Image payloads are charged a bounded
 * constant, and stored tool images are charged nothing at all because
 * `sanitizeToolResultImages` strips them from every replayed prompt. See
 * `lib/prompt-size.ts` for the single price list shared by this module, the
 * compaction planner and the agent loop.
 */

/**
 * A snapshot of how full the model's context window currently is.
 *
 * `tokens` is the committed context (everything that would be sent on the next
 * request, excluding an unsent draft). `estimated` is `true` when no completed
 * step has anchored the number; the UI renders that as "unknown" rather than a
 * percentage, so a guess can never masquerade as a measurement.
 */
export interface ContextUsage {
  /** Committed context size in tokens (excludes the unsent draft). */
  tokens: number;
  /** The model's declared window, always > 0. */
  contextWindow: number;
  /** `tokens / contextWindow`, clamped to 100 for display. */
  percent: number;
  /** True when no real provider usage anchored the estimate. */
  estimated: boolean;
  /** Input tokens of the anchoring step, for the tooltip breakdown. */
  inputTokens: number;
  /** Output tokens of the anchoring step. */
  outputTokens: number;
  /** Tokens estimated for messages after the anchor plus any live streamed parts. */
  trailingTokens: number;
}

/**
 * The most recent completed step of the in-flight turn.
 *
 * A persisted turn carries its usage only once it settles, so a streaming
 * conversation would otherwise run on the heuristic from the first token to the
 * last. `coveredPartCount` is the number of streamed parts that the anchored
 * prompt already contains — everything after it is the delta the estimate must
 * add. Without that split the step's own output would be counted twice.
 */
export interface LiveUsage {
  usage: TokenUsageStats;
  /** Length of the streamed part list the anchor already covers. */
  coveredPartCount: number;
}

export interface ContextUsageInput {
  messages: readonly ChatMessage[];
  /** System-prompt snapshot sent ahead of the conversation, when known. */
  systemPrompt?: string;
  /** Live assistant parts while a turn is streaming and not yet persisted. */
  pendingParts?: readonly ChatMessagePart[];
  /** The selected model, whose declared window sizes the ring. */
  model?: Pick<ModelConfig, 'contextWindow'>;
  /** Most recent completed step of the in-flight turn, when one exists. */
  liveUsage?: LiveUsage;
  /**
   * Durable compaction checkpoint, when one exists.
   *
   * Assistant usage recorded *before* the checkpoint describes a prompt that
   * carried the un-summarized history, so it is not a valid anchor any more.
   * Only turns that ran after `createdAt` re-anchor the estimate; until then the
   * summary is counted by the heuristic alongside the kept messages.
   */
  compaction?: ConversationCompaction;
}

/**
 * App-level entry point: everything the ring needs comes from the conversation
 * itself, so a caller cannot accidentally pair messages with another
 * conversation's checkpoint.
 */
export interface ConversationContextUsageInput {
  conversation: Pick<Conversation, 'messages' | 'systemPrompt' | 'compaction'>;
  model?: Pick<ModelConfig, 'contextWindow'>;
  pendingParts?: readonly ChatMessagePart[];
  liveUsage?: LiveUsage;
}

/** The chars/4 heuristic for a plain string. */
export function estimateTextTokens(text: string): number {
  return estimateCharsToTokens(text.length);
}

/**
 * Chars/4 estimate over an ordered part list.
 *
 * `mode` is required on purpose: measuring stored parts as `live` would charge
 * images the prompt never carries, and measuring streamed parts as `replayed`
 * would hide images the prompt does carry.
 */
export function estimatePartsTokens(
  parts: readonly ChatMessagePart[],
  mode: ImageAccounting,
): number {
  return estimateCharsToTokens(measureUIPartsChars(parts, mode));
}

/** Chars/4 estimate for a stored message, resolving any active variant. */
export function estimateMessageTokens(message: ChatMessage): number {
  return estimatePartsTokens(normalizeMessage(message), 'replayed');
}

/**
 * Estimate the tokens an unsent draft and its attachments would add.
 *
 * Deliberately separate from {@link computeContextUsage}: the ring body shows
 * the committed context only, so a number that moves on every keystroke never
 * makes the progress arc jitter. The tooltip surfaces this as "pending".
 */
export function estimateDraftTokens(draft: {
  text: string;
  images: readonly string[];
  attachments: readonly Pick<TextAttachment, 'content'>[];
}): number {
  let chars = draft.text.length;
  for (const attachment of draft.attachments) chars += attachment.content.length;
  chars += draft.images.length * IMAGE_CHARS;
  return estimateCharsToTokens(chars);
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** The usage variant-aware UI shows, so the ring matches the visible reply. */
function activeUsage(message: ChatMessage): TokenUsageStats | undefined {
  if (
    message.variants &&
    message.activeVariantIndex !== undefined &&
    message.activeVariantIndex < message.variants.length
  ) {
    return message.variants[message.activeVariantIndex]!.usage;
  }
  return message.usage;
}

/**
 * A real prompt size, plus the split the tooltip shows.
 *
 * Cache reads/writes are omitted on purpose: they are a billing breakdown of
 * the same input tokens and would double-count occupancy. `TokenUsageStats`
 * keeps them for the per-message usage view.
 */
interface StepMeasurement {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Measure the *last* step of a usage record.
 *
 * A turn's `usage.inputTokens` is the sum over every tool step; the final
 * step's input is the prompt actually assembled for that step, and adding its
 * output gives the context that carries into the next turn. Without a per-step
 * record the aggregate is the billing view and would count the same history
 * once per step, so it is *not* a usable anchor — the caller falls back to the
 * heuristic instead. Returns `null` for aborted (no steps), all-zero usage, and
 * legacy aggregates.
 */
function measureStep(usage: TokenUsageStats): StepMeasurement | null {
  const last = usage.steps?.at(-1);
  if (!last) return null;
  const tokens = last.inputTokens + last.outputTokens;
  if (tokens <= 0) return null;
  return {
    tokens,
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
  };
}

interface ContextAnchor {
  index: number;
  measured: StepMeasurement;
}

/**
 * The most recent assistant turn with a real prompt count.
 *
 * Anything after it (a fresh user message, a partially streamed reply) is
 * estimated and added on top. Turns recorded before a compaction checkpoint are
 * skipped: their usage measured a prompt that included history the checkpoint
 * has since folded away, so trusting it would overstate the window.
 */
function findAnchor(
  messages: readonly ChatMessage[],
  compaction: ConversationCompaction | undefined,
): ContextAnchor | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    if (compaction && message.timestamp <= compaction.createdAt) continue;
    const usage = activeUsage(message);
    if (!usage) continue;
    const measured = measureStep(usage);
    if (measured) return { index: i, measured };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

function messageTokensAfter(
  messages: readonly ChatMessage[],
  index: number,
): number {
  let tokens = 0;
  for (let i = index + 1; i < messages.length; i++) {
    tokens += estimateMessageTokens(messages[i]!);
  }
  return tokens;
}

/**
 * Estimate the whole stored context when no anchor is available.
 *
 * Tool schemas are not visible from here and are the largest omission; the
 * first completed turn replaces this with the exact count. A checkpoint's
 * summary rides ahead of the kept transcript, and only the kept range is
 * actually sent — counting the summarized messages too would overstate the
 * window by exactly the history compaction just removed.
 */
function estimateStoredTokens(input: ContextUsageInput): number {
  let tokens = input.systemPrompt ? estimateTextTokens(input.systemPrompt) : 0;
  const { compaction, messages } = input;
  if (!compaction) {
    for (const message of messages) tokens += estimateMessageTokens(message);
    return tokens;
  }

  tokens += estimateTextTokens(compaction.summary);
  const boundary = messages.findIndex((message) => message.id === compaction.firstKeptMessageId);
  const kept = boundary >= 0 ? messages.slice(boundary) : messages;
  for (const message of kept) tokens += estimateMessageTokens(message);
  return tokens;
}

/** Assemble the public shape, clamping the display percentage in one place. */
function buildContextUsage(params: Omit<ContextUsage, 'percent'>): ContextUsage {
  return {
    ...params,
    percent: Math.min(100, (params.tokens / params.contextWindow) * 100),
  };
}

/**
 * Occupancy from the in-flight turn's latest completed step.
 *
 * This is strictly newer than anything persisted, so only the parts streamed
 * after it are missing. It keeps the ring calibrated *during* a tool loop
 * instead of only between turns.
 */
function liveContextUsage(
  input: ContextUsageInput,
  contextWindow: number,
): ContextUsage | null {
  const live = input.liveUsage;
  if (!live) return null;
  const measured = measureStep(live.usage);
  if (!measured) return null;

  const pending = input.pendingParts ?? [];
  const from = Math.min(Math.max(0, live.coveredPartCount), pending.length);
  const trailingTokens = estimatePartsTokens(pending.slice(from), 'live');
  return buildContextUsage({
    tokens: measured.tokens + trailingTokens,
    contextWindow,
    estimated: false,
    inputTokens: measured.inputTokens,
    outputTokens: measured.outputTokens,
    trailingTokens,
  });
}

/**
 * Compute the current context occupancy, or `null` when the model declares no
 * window — the caller hides the ring rather than drawing a meaningless arc.
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsage | null {
  const contextWindow = input.model?.contextWindow ?? 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  const live = liveContextUsage(input, contextWindow);
  if (live) return live;

  const anchor = findAnchor(input.messages, input.compaction);
  const pendingTokens = estimatePartsTokens(input.pendingParts ?? [], 'live');
  const trailingTokens =
    (anchor ? messageTokensAfter(input.messages, anchor.index) : estimateStoredTokens(input)) +
    pendingTokens;

  if (anchor) {
    return buildContextUsage({
      tokens: anchor.measured.tokens + trailingTokens,
      contextWindow,
      estimated: false,
      inputTokens: anchor.measured.inputTokens,
      outputTokens: anchor.measured.outputTokens,
      trailingTokens,
    });
  }

  return buildContextUsage({
    tokens: trailingTokens,
    contextWindow,
    estimated: true,
    inputTokens: 0,
    outputTokens: 0,
    trailingTokens,
  });
}

/** {@link computeContextUsage} for a conversation, without the field mapping. */
export function computeConversationContextUsage(
  input: ConversationContextUsageInput,
): ContextUsage | null {
  return computeContextUsage({
    messages: input.conversation.messages,
    ...(input.conversation.systemPrompt !== undefined
      ? { systemPrompt: input.conversation.systemPrompt }
      : {}),
    ...(input.conversation.compaction ? { compaction: input.conversation.compaction } : {}),
    ...(input.pendingParts ? { pendingParts: input.pendingParts } : {}),
    ...(input.liveUsage ? { liveUsage: input.liveUsage } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
}

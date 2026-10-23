import type {
  ChatMessage,
  ChatMessagePart,
  ConversationCompaction,
  ModelConfig,
  TextAttachment,
  TokenUsageStats,
} from '@/types';
import { normalizeMessage } from '@/lib/message-parts';

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
 * This is a deliberately coarse estimate for the trailing edge. It exists to
 * fill the gap between turns, not to replace the provider's own count: the next
 * completed turn re-anchors the number to something exact.
 */

/** Conservative chars-per-token ratio used by the heuristic estimator. */
const CHARS_PER_TOKEN = 4;

/** Character cost assumed for one image part (≈1200 tokens, matching pi). */
const IMAGE_CHARS = 4800;

/**
 * A snapshot of how full the model's context window currently is.
 *
 * `tokens` is the committed context (everything that would be sent on the next
 * request, excluding an unsent draft). `estimated` is `true` when no completed
 * turn has anchored the number, i.e. the whole value is the chars/4 heuristic.
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
  /** Cached input tokens read by the anchoring step, when the provider reports them. */
  cacheReadTokens: number;
  /** Cached input tokens written by the anchoring step, when the provider reports them. */
  cacheWriteTokens: number;
  /** Tokens estimated for messages after the anchor plus any live streamed parts. */
  trailingTokens: number;
}

export interface ContextUsageInput {
  messages: readonly ChatMessage[];
  /** System-prompt snapshot sent ahead of the conversation, when known. */
  systemPrompt?: string;
  /** Live assistant parts while a turn is streaming and not yet persisted. */
  pendingParts?: readonly ChatMessagePart[];
  /** The selected model, whose declared window sizes the ring. */
  model?: Pick<ModelConfig, 'contextWindow'>;
  /**
   * Durable compaction checkpoint, when one exists.
   *
   * Assistant usage recorded *before* the checkpoint describes a prompt that
   * carried the un-summarized history, so it is not a valid anchor any more.
   * Only turns that ran after `createdAt` re-anchor the estimate; until then the
   * summary is counted by the heuristic alongside the kept messages.
   */
  compaction?: Pick<ConversationCompaction, 'createdAt' | 'summary' | 'firstKeptMessageId'>;
}

/** The chars/4 heuristic for a plain string. */
export function estimateTextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimatePartChars(part: ChatMessagePart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text.length;
    case 'file':
      return IMAGE_CHARS;
    default:
      // Tool and data parts: serialising is the honest approximation, since
      // their payloads are structured rather than prose.
      return JSON.stringify(part).length;
  }
}

/** Chars/4 estimate over an ordered part list. */
export function estimatePartsTokens(parts: readonly ChatMessagePart[]): number {
  let chars = 0;
  for (const part of parts) chars += estimatePartChars(part);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Chars/4 estimate for a stored message, resolving any active variant. */
export function estimateMessageTokens(message: ChatMessage): number {
  return estimatePartsTokens(normalizeMessage(message));
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
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

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
 * The context size a completed turn ended at, from its *last* step.
 *
 * A turn's `usage.inputTokens` is the sum over every tool step; the final
 * step's input is the prompt actually assembled for that step, and adding its
 * output gives the context that carries into the next turn. Returns `null` when
 * the turn recorded no usable usage (aborted before any step completed).
 */
function turnContextTokens(usage: TokenUsageStats): number | null {
  const last = usage.steps?.at(-1);
  const input = last ? last.inputTokens : usage.inputTokens;
  const output = last ? last.outputTokens : usage.outputTokens;
  const total = input + output;
  return total > 0 ? total : null;
}

/**
 * Compute the current context occupancy, or `null` when the model declares no
 * window — the caller hides the ring rather than drawing a meaningless arc.
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsage | null {
  const contextWindow = input.model?.contextWindow ?? 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  // Walk backwards to the most recent assistant turn with a real prompt count.
  // Anything after it (a fresh user message, a partially streamed reply) is
  // estimated and added on top. Turns recorded before a compaction checkpoint
  // are skipped: their usage measured a prompt that included history the
  // checkpoint has since folded away, so trusting it would overstate the window.
  let anchorIndex = -1;
  let anchorUsage: TokenUsageStats | undefined;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]!;
    if (message.role !== 'assistant') continue;
    if (input.compaction && message.timestamp <= input.compaction.createdAt) continue;
    const usage = activeUsage(message);
    if (usage && turnContextTokens(usage) !== null) {
      anchorIndex = i;
      anchorUsage = usage;
      break;
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let trailingTokens = 0;

  if (anchorUsage) {
    const last = anchorUsage.steps?.at(-1);
    inputTokens = last ? last.inputTokens : anchorUsage.inputTokens;
    outputTokens = last ? last.outputTokens : anchorUsage.outputTokens;
    cacheReadTokens = last?.cacheReadTokens ?? anchorUsage.cacheReadTokens ?? 0;
    cacheWriteTokens = last?.cacheWriteTokens ?? anchorUsage.cacheWriteTokens ?? 0;
    for (let i = anchorIndex + 1; i < input.messages.length; i++) {
      trailingTokens += estimateMessageTokens(input.messages[i]!);
    }
  } else {
    // No turn has run against a real prompt yet, so the whole context is a
    // heuristic. Tool schemas are not visible from here and are the largest
    // omission; the first completed turn replaces this with the exact count.
    // A checkpoint's summary rides ahead of the kept transcript, and only the
    // kept range is actually sent — counting the summarized messages too would
    // overstate the window by exactly the history compaction just removed.
    if (input.systemPrompt) trailingTokens += estimateTextTokens(input.systemPrompt);
    if (input.compaction) {
      trailingTokens += estimateTextTokens(input.compaction.summary);
      const boundary = input.messages.findIndex(
        (message) => message.id === input.compaction!.firstKeptMessageId,
      );
      const kept = boundary >= 0 ? input.messages.slice(boundary) : input.messages;
      for (const message of kept) trailingTokens += estimateMessageTokens(message);
    } else {
      for (const message of input.messages) trailingTokens += estimateMessageTokens(message);
    }
  }

  const pending = input.pendingParts?.length
    ? estimatePartsTokens(input.pendingParts)
    : 0;
  trailingTokens += pending;

  const tokens = inputTokens + outputTokens + trailingTokens;
  return {
    tokens,
    contextWindow,
    percent: Math.min(100, (tokens / contextWindow) * 100),
    estimated: anchorUsage === undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    trailingTokens,
  };
}

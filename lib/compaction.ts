/**
 * Context compaction — summarize old history into a durable checkpoint.
 *
 * The browser side panel can run very long conversations, and every turn
 * replays the whole transcript to the model. Once the committed context
 * approaches the model's window there is no room left for the next reply, so
 * older history is folded into a structured summary and replaced in the prompt
 * by a single checkpoint message.
 *
 * This module is deliberately pure: it operates on `Conversation` /
 * `ChatMessage` values and never touches the network, React or storage. The
 * orchestrator (`store/useChatStream.ts`) owns persistence, and `lib/ai.ts`
 * owns the summarization LLM call. That split keeps the cut-point math and the
 * prompt shape unit-testable in isolation.
 *
 * Storage stays lossless: `Conversation.messages` is never rewritten. Only the
 * *prompt projection* skips the summarized range, so the transcript remains
 * readable and can be summarized again as the conversation grows.
 */

import { isToolUIPart, getToolName } from 'ai';
import { estimateMessageTokens } from '@/lib/context-usage';
import { formatContextTokens } from '@/lib/context-window';
import { normalizeMessage } from '@/lib/message-parts';
import { normalizeToolOutput } from '@/lib/tool-output';
import type {
  ChatMessage,
  ChatMessagePart,
  CompactionSettings,
  Conversation,
  ConversationCompaction,
  ReserveAmount,
  TokenUsageStats,
} from '@/types';

/**
 * Shipped defaults: 20% of the window reserved, 20k of recent history kept.
 *
 * A percentage is the better default because it scales with the model — the same
 * setting leaves sensible headroom on a 32K model and on a 1M one. The 20k
 * keep-budget mirrors pi.
 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserve: { unit: 'percent', value: 20 },
  keepRecentTokens: 20000,
};

/**
 * Bounds on a token budget. A value below this cannot be a real budget, so it is
 * far more likely a typo than an intentional setting.
 */
export const MIN_KEEP_RECENT_TOKENS = 1024;
/** Upper bound, matching the model context-window ceiling. */
export const MAX_COMPACTION_TOKENS = 10_000_000;
/** A reserve below 1% is meaningless; at 90% almost nothing would be sendable. */
export const MIN_RESERVE_PERCENT = 1;
export const MAX_RESERVE_PERCENT = 90;

/**
 * Reserve choices offered by the options page, in display order.
 *
 * A curated mix: absolute counts pin a fixed headroom, percentages scale with
 * the model. Sorted smallest-to-largest within each unit.
 */
export const RESERVE_PRESETS: readonly ReserveAmount[] = [
  { unit: 'tokens', value: 16_000 },
  { unit: 'tokens', value: 32_000 },
  { unit: 'tokens', value: 64_000 },
  { unit: 'tokens', value: 128_000 },
  { unit: 'percent', value: 10 },
  { unit: 'percent', value: 20 },
  { unit: 'percent', value: 30 },
];

/** Presets offered by the options page, largest first. */
export const KEEP_RECENT_TOKEN_PRESETS = [8000, 16000, 20000, 32000, 50000] as const;

function normalizeTokenCount(raw: unknown, fallback: number, min: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const tokens = Math.trunc(n);
  if (tokens < min) return fallback;
  return Math.min(tokens, MAX_COMPACTION_TOKENS);
}

/**
 * Coerce a stored reserve into the tagged shape.
 *
 * Accepts the legacy bare-number form (`reserveTokens`), which predates the
 * unit split and was always an absolute count.
 */
function normalizeReserve(raw: unknown): ReserveAmount {
  if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n >= MIN_KEEP_RECENT_TOKENS) {
      return { unit: 'tokens', value: Math.min(Math.trunc(n), MAX_COMPACTION_TOKENS) };
    }
    return DEFAULT_COMPACTION_SETTINGS.reserve;
  }
  if (raw && typeof raw === 'object') {
    const candidate = raw as { unit?: unknown; value?: unknown };
    const value = typeof candidate.value === 'number' ? candidate.value : Number(candidate.value);
    if (Number.isFinite(value)) {
      if (candidate.unit === 'percent') {
        const percent = Math.trunc(value);
        if (percent >= MIN_RESERVE_PERCENT && percent <= MAX_RESERVE_PERCENT) {
          return { unit: 'percent', value: percent };
        }
      } else if (candidate.unit === 'tokens') {
        if (value >= MIN_KEEP_RECENT_TOKENS) {
          return { unit: 'tokens', value: Math.min(Math.trunc(value), MAX_COMPACTION_TOKENS) };
        }
      }
    }
  }
  return DEFAULT_COMPACTION_SETTINGS.reserve;
}

/**
 * Coerces a stored (or imported) settings record into a usable one.
 *
 * Compaction defaults to **on**: the feature exists to stop long chats from
 * hitting a hard context limit, and an install that predates this field would
 * otherwise keep failing the way it always did.
 */
export function normalizeCompactionSettings(raw: {
  enabled?: unknown;
  reserve?: unknown;
  /** Legacy absolute-only field, superseded by `reserve`. */
  reserveTokens?: unknown;
  keepRecentTokens?: unknown;
} | undefined): CompactionSettings {
  return {
    enabled: raw?.enabled !== false,
    reserve: normalizeReserve(raw?.reserve ?? raw?.reserveTokens),
    keepRecentTokens: normalizeTokenCount(
      raw?.keepRecentTokens,
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      MIN_KEEP_RECENT_TOKENS,
    ),
  };
}

/** Resolve a reserve to an absolute token count for a given window. */
export function resolveReserveTokens(reserve: ReserveAmount, contextWindow: number): number {
  if (reserve.unit === 'percent') {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
    return Math.round((contextWindow * reserve.value) / 100);
  }
  return reserve.value;
}

/** Compact, unit-aware label for a reserve (`16K`, `20%`). */
export function formatReserveAmount(reserve: ReserveAmount): string {
  if (reserve.unit === 'percent') return `${reserve.value}%`;
  return formatContextTokens(reserve.value);
}

/** Stable string key for select controls and equality checks. */
export function reserveKey(reserve: ReserveAmount): string {
  return `${reserve.unit}:${reserve.value}`;
}

/** Parse a key produced by {@link reserveKey} back into a reserve. */
export function parseReserveKey(key: string): ReserveAmount | undefined {
  const [unit, rawValue] = key.split(':');
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return undefined;
  if (unit === 'percent') return { unit: 'percent', value };
  if (unit === 'tokens') return { unit: 'tokens', value };
  return undefined;
}

/** Whether `reserve` is one of the dropdown presets. */
export function isReservePreset(reserve: ReserveAmount): boolean {
  return RESERVE_PRESETS.some((preset) => reserveKey(preset) === reserveKey(reserve));
}

export function isKeepRecentPreset(value: number): boolean {
  return (KEEP_RECENT_TOKEN_PRESETS as readonly number[]).includes(value);
}

// ---------------------------------------------------------------------------
// Prompt shape (mirrors pi's structured checkpoint)
// ---------------------------------------------------------------------------

/**
 * Wrapper injected ahead of the kept transcript. A dedicated, clearly-delimited
 * user message is how pi surfaces a compaction checkpoint, and it keeps the
 * model from reading the summary as a fresh instruction.
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
export const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

export const SUMMARY_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const INITIAL_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact URLs, page titles, tool names and error messages.`;

const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact URLs, page titles, tool names and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact URLs, page titles, tool names and error messages.`;

/**
 * Build the summarization request for an already-serialized transcript.
 *
 * Kept text-in / text-out so both the durable path (stored `ChatMessage`s) and
 * the in-loop path (wire `ModelMessage`s) share one prompt.
 */
export function buildSummaryPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string,
): { system: string; prompt: string } {
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += previousSummary ? UPDATE_SUMMARY_PROMPT : INITIAL_SUMMARY_PROMPT;
  if (customInstructions) {
    prompt += `\n\nAdditional focus: ${customInstructions}`;
  }
  return { system: SUMMARY_SYSTEM_PROMPT, prompt };
}

// ---------------------------------------------------------------------------
// Threshold + cut point
// ---------------------------------------------------------------------------

/**
 * Whether `contextTokens` has crossed `contextWindow - reserveTokens`.
 *
 * Shared by the pre-send decision (stored transcript) and the between-step
 * decision (in-memory wire prompt) so the two thresholds cannot drift apart.
 */
export function exceedsBudget(
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return contextTokens > contextWindow - reserveTokens;
}

/** Whether the committed context has crossed the compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return exceedsBudget(
    contextTokens,
    contextWindow,
    resolveReserveTokens(settings.reserve, contextWindow),
  );
}

export interface CompactionPlan {
  /** First stored message that stays verbatim. */
  firstKeptMessageId: string;
  /** Messages folded into the checkpoint. */
  messagesToSummarize: ChatMessage[];
  /** The checkpoint being superseded, when this is a repeat compaction. */
  previousSummary?: string;
}

/**
 * Lifecycle of an automatic compaction run.
 *
 * Surfaced to the store so a silent summary call can no longer look like a
 * stalled reply: `start` raises the compacting state, `end` / `failed` clears
 * it, and `end` carries the size change for a transient notice. Token counts
 * describe the *history* being folded (system prompt and tool schemas are not
 * part of the wire message list), so before and after share one basis.
 */
export type CompactionEvent =
  | { phase: 'start'; tokensBefore: number }
  | { phase: 'end'; tokensBefore: number; tokensAfter: number }
  | { phase: 'failed'; tokensBefore: number; error: unknown };

/** Index of the first kept message, or `-1` when the boundary is gone. */
export function firstKeptIndex(conv: Conversation): number {
  if (!conv.compaction) return -1;
  return conv.messages.findIndex((m) => m.id === conv.compaction!.firstKeptMessageId);
}

/**
 * Choose which stored messages to summarize, keeping roughly
 * `keepRecentTokens` verbatim.
 *
 * Walks backwards from the newest message accumulating estimated sizes until
 * the budget is reached, then cuts there. Unlike pi there is no "don't cut at a
 * tool result" rule to enforce: every stored `ChatMessage` is self-contained
 * (an assistant turn carries its own tool calls *and* results), so any message
 * boundary is a valid cut point.
 *
 * Returns `null` when nothing can be summarized — the transcript already fits
 * the budget, or the boundary is the only thing left.
 */
export function planCompaction(
  conv: Conversation,
  keepRecentTokens: number,
): CompactionPlan | null {
  const messages = conv.messages;
  if (messages.length === 0) return null;

  const existing = conv.compaction;
  let start = 0;
  if (existing) {
    const idx = firstKeptIndex(conv);
    // A boundary whose message no longer exists cannot be honored. Starting
    // from the top lets the next checkpoint re-cover the whole transcript.
    start = idx >= 0 ? idx : 0;
  }

  let accumulated = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= start; i--) {
    accumulated += estimateMessageTokens(messages[i]!);
    if (accumulated >= keepRecentTokens) {
      cut = i;
      break;
    }
  }

  // `cut <= start` means the whole range already fits the budget (or the only
  // remaining message would be summarized away), so there is nothing to do.
  if (cut <= start) return null;

  const messagesToSummarize = messages.slice(start, cut);
  if (messagesToSummarize.length === 0) return null;

  return {
    firstKeptMessageId: messages[cut]!.id,
    messagesToSummarize,
    ...(existing ? { previousSummary: existing.summary } : {}),
  };
}

/**
 * Project a conversation into the message list that should be sent to the
 * model: the checkpoint (when one exists) followed by kept messages.
 *
 * The checkpoint is a synthetic user message — it exists only inside the
 * prompt, is regenerated on demand, and is never persisted or rendered. When
 * the boundary message is missing (deleted, or an older record) the projection
 * degrades to the full transcript rather than dropping history.
 */
export function projectConversation(conv: Conversation): ChatMessage[] {
  const compaction = conv.compaction;
  if (!compaction) return conv.messages;

  const idx = firstKeptIndex(conv);
  if (idx < 0) return conv.messages;

  const summaryMessage: ChatMessage = {
    id: `lumo-compaction-${compaction.createdAt}`,
    role: 'user',
    parts: [
      {
        type: 'text',
        text: COMPACTION_SUMMARY_PREFIX + compaction.summary + COMPACTION_SUMMARY_SUFFIX,
        state: 'done',
      },
    ],
    timestamp: compaction.createdAt,
  };

  return [summaryMessage, ...conv.messages.slice(idx)];
}

/** Apply a generated checkpoint to a conversation, returning a new record. */
export function applyCompaction(
  conv: Conversation,
  result: {
    summary: string;
    firstKeptMessageId: string;
    tokensBefore: number;
    tokensAfter?: number;
    /**
     * Where the transcript seam belongs. Defaults to the newest message at the
     * moment of compaction — the chronological trigger point — which is what pi
     * renders, independent of where the prompt projection starts.
     */
    triggeredAtMessageId?: string;
    usage?: TokenUsageStats;
  },
): Conversation {
  const triggeredAtMessageId =
    result.triggeredAtMessageId ?? conv.messages[conv.messages.length - 1]?.id;
  const compaction: ConversationCompaction = {
    summary: result.summary,
    firstKeptMessageId: result.firstKeptMessageId,
    ...(triggeredAtMessageId ? { triggeredAtMessageId } : {}),
    tokensBefore: result.tokensBefore,
    ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}),
    createdAt: Date.now(),
    ...(result.usage ? { usage: result.usage } : {}),
  };
  return { ...conv, compaction, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Serialization for the summarizer
// ---------------------------------------------------------------------------

/** Maximum characters of a single tool result fed to the summarizer. */
export const SUMMARY_TOOL_RESULT_MAX_CHARS = 2000;
/** Maximum characters of tool-call arguments fed to the summarizer. */
export const SUMMARY_TOOL_ARGS_MAX_CHARS = 500;

/** Clamp a payload fed to the summarizer, noting how much was dropped. */
export function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

function textOfPart(part: ChatMessagePart): string | undefined {
  if (part.type === 'text') return part.text;
  if (part.type === 'file') return '[image]';
  return undefined;
}

function serializeToolCall(part: ChatMessagePart): string {
  const name = getToolName(part as never);
  const input = (part as { input?: unknown }).input;
  let args = '';
  try {
    args = input === undefined ? '' : JSON.stringify(input);
  } catch {
    args = String(input);
  }
  return `${name}(${truncateForSummary(args, SUMMARY_TOOL_ARGS_MAX_CHARS)})`;
}

function serializeToolResult(part: ChatMessagePart): string | undefined {
  const output = (part as { output?: unknown }).output;
  if (output === undefined) return undefined;
  const normalized = normalizeToolOutput(output);
  switch (normalized.kind) {
    case 'text':
      return truncateForSummary(normalized.text, SUMMARY_TOOL_RESULT_MAX_CHARS);
    case 'error':
      return `error: ${truncateForSummary(normalized.message, SUMMARY_TOOL_RESULT_MAX_CHARS)}`;
    case 'image':
    case 'image-ref':
      return '[image]';
    default:
      return undefined;
  }
}

/**
 * Flatten stored messages into plain text so the model summarizes rather than
 * continues the conversation. Reasoning is omitted: providers only replay a
 * summary of it anyway, and including it would make the request larger than the
 * context it summarizes.
 */
export function serializeConversationForSummary(messages: readonly ChatMessage[]): string {
  const blocks: string[] = [];

  for (const message of messages) {
    const parts = normalizeMessage(message);

    if (message.role === 'user') {
      const text = parts.map(textOfPart).filter((t): t is string => !!t).join('\n');
      if (text) blocks.push(`[User]: ${text}`);
      continue;
    }

    const assistantText = parts
      .filter((p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    if (assistantText) blocks.push(`[Assistant]: ${assistantText}`);

    const calls: string[] = [];
    const results: string[] = [];
    for (const part of parts) {
      if (!isToolUIPart(part)) continue;
      calls.push(serializeToolCall(part));
      const result = serializeToolResult(part);
      if (result) results.push(`[Tool result]: ${result}`);
    }
    if (calls.length > 0) blocks.push(`[Assistant tool calls]: ${calls.join('; ')}`);
    if (results.length > 0) blocks.push(...results);
  }

  return blocks.join('\n\n');
}

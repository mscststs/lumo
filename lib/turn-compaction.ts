/**
 * Turn-boundary compaction orchestration.
 *
 * Three call sites need the same sequence — decide whether to fold, choose the
 * cut, summarize, apply the checkpoint — and differ only in what triggers them:
 *
 * - the pre-send check (threshold),
 * - a manual `/compact` (unconditional),
 * - context-overflow recovery (unconditional, then one retry).
 *
 * Keeping the sequence here means the three cannot drift in cut policy or in
 * the token counts they report. The summarizer is injected so this module never
 * depends on a provider, and the caller owns persistence (opening and saving
 * the returned conversation).
 */

import { applyCompaction, planCompaction, shouldCompact } from '@/lib/compaction';
import { computeConversationContextUsage } from '@/lib/context-usage';
import type {
  ChatMessage,
  CompactionSettings,
  Conversation,
  ModelConfig,
  TokenUsageStats,
} from '@/types';

/** Payload a summarizer needs; provider and model are bound by the caller. */
export interface SummarizeMessagesInput {
  messages: ChatMessage[];
  previousSummary?: string;
  conversationId: string;
  signal?: AbortSignal;
}

export type SummarizeMessages = (
  input: SummarizeMessagesInput,
) => Promise<{ text: string; usage?: TokenUsageStats }>;

export interface CompactTurnInput {
  conversation: Conversation;
  model: Pick<ModelConfig, 'contextWindow'>;
  settings: CompactionSettings;
  summarize: SummarizeMessages;
  signal?: AbortSignal;
  /** Fold regardless of the threshold (manual `/compact`, overflow recovery). */
  force?: boolean;
}

export interface CompactTurnResult {
  conversation: Conversation;
  /** Committed size before the fold, for the compaction notice. */
  tokensBefore: number;
  /** Estimated committed size after the fold; the next reply re-anchors it. */
  tokensAfter: number;
  /** Usage of the summarization call, when the provider reported it. */
  usage?: TokenUsageStats;
}

/**
 * Fold older history into a checkpoint, or return `null` when there is nothing
 * to do — the context is under the threshold, or the whole transcript already
 * fits the retained-token budget.
 */
export async function compactTurn(
  input: CompactTurnInput,
): Promise<CompactTurnResult | null> {
  const usage = computeConversationContextUsage({
    conversation: input.conversation,
    model: input.model,
  });

  if (!input.force) {
    const contextWindow = input.model.contextWindow ?? 0;
    if (!usage || !shouldCompact(usage.tokens, contextWindow, input.settings)) {
      return null;
    }
  }

  const plan = planCompaction(input.conversation, input.settings.keepRecentTokens);
  if (!plan) return null;

  const summary = await input.summarize({
    messages: plan.messagesToSummarize,
    ...(plan.previousSummary ? { previousSummary: plan.previousSummary } : {}),
    conversationId: input.conversation.id,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const conversation = applyCompaction(input.conversation, {
    summary: summary.text,
    firstKeptMessageId: plan.firstKeptMessageId,
    tokensBefore: usage?.tokens ?? 0,
    ...(summary.usage ? { usage: summary.usage } : {}),
  });
  const tokensAfter =
    computeConversationContextUsage({ conversation, model: input.model })?.tokens ?? 0;

  return {
    conversation,
    tokensBefore: usage?.tokens ?? 0,
    tokensAfter,
    ...(summary.usage ? { usage: summary.usage } : {}),
  };
}

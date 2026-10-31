/**
 * Between-step context compaction for the agent loop.
 *
 * The loop can outgrow the window mid-turn: one page read or screenshot bundle
 * can double the prompt between two tool calls. The durable, pre-send
 * compaction in the store runs once per turn, so a second mechanism folds the
 * *in-memory* wire prompt before the next model request. Nothing here touches
 * persistence — the store writes the durable checkpoint at the next turn
 * boundary.
 *
 * Kept out of `lib/ai.ts` so the transport module (providers, tools, streaming)
 * does not also own summary serialization and cut-point policy. All size
 * measurement goes through `lib/prompt-size.ts`, the same price list the
 * composer ring uses.
 */

import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
} from 'ai';
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  SUMMARY_TOOL_ARGS_MAX_CHARS,
  SUMMARY_TOOL_RESULT_MAX_CHARS,
  buildSummaryPrompt,
  exceedsBudget,
  truncateForSummary,
  type CompactionEvent,
} from '@/lib/compaction';
import {
  estimateCharsToTokens,
  measureModelMessageChars,
  measureModelMessagesChars,
} from '@/lib/prompt-size';
import type { UnifiedReasoningEffort } from '@/lib/reasoning-effort';

/** Thresholds and continuity state for one in-memory fold. */
export interface WireCompactionConfig {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
  priorSummary?: string;
  summaryMessageCount: number;
}

export interface WireCompactionInput {
  messages: ModelMessage[];
  model: LanguageModel;
  providerOptions?: ProviderMetadata;
  reasoning?: UnifiedReasoningEffort;
  signal?: AbortSignal;
  config: WireCompactionConfig;
  /** Committed context tokens from the last completed step (includes schemas). */
  anchorTokens: number;
  /** Wire messages appended after that step, whose size is not in the anchor. */
  appendedChars: number;
  /** Emits lifecycle events so the UI can show that context is being folded. */
  onEvent?: (event: CompactionEvent) => void;
}

/** What a successful in-memory fold hands back to the loop. */
export interface WireCompactionResult {
  messages: ModelMessage[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Serialization for the summarizer
// ---------------------------------------------------------------------------

/** A permissive view of a wire content part, for the summary serializer. */
interface WireContentPart {
  type?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

function wireContentParts(message: ModelMessage): WireContentPart[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as WireContentPart[]) : [];
}

/**
 * Flatten wire messages to text so the summarizer continues nothing.
 * Mirrors the stored-message serializer in `lib/compaction.ts`.
 */
function serializeWireForSummary(messages: readonly ModelMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const text = wireContentParts(message)
        .map((part) => (part.type === 'text' ? part.text ?? '' : '[image]'))
        .join('');
      if (text) blocks.push(`[User]: ${text}`);
      continue;
    }

    if (message.role === 'assistant') {
      const parts = wireContentParts(message);
      const text = parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
      if (text) blocks.push(`[Assistant]: ${text}`);
      const calls = parts
        .filter((part) => part.type === 'tool-call')
        .map((part) => {
          const args = serializeArgs(part.input);
          return `${part.toolName ?? 'tool'}(${truncateForSummary(args, SUMMARY_TOOL_ARGS_MAX_CHARS)})`;
        });
      if (calls.length > 0) blocks.push(`[Assistant tool calls]: ${calls.join('; ')}`);
      continue;
    }

    // Tool role: render each tool result, truncated.
    for (const part of wireContentParts(message)) {
      if (part.type !== 'tool-result') continue;
      const rendered = renderToolOutput(part.output);
      if (rendered) {
        blocks.push(`[Tool result]: ${truncateForSummary(rendered, SUMMARY_TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }
  return blocks.join('\n\n');
}

function serializeArgs(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function renderToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return '';
  const record = output as { type?: string; value?: unknown };
  if (record.type === 'text') return String(record.value ?? '');
  if (typeof record.value === 'string') return record.value;
  try {
    return JSON.stringify(record.value);
  } catch {
    return String(record.value);
  }
}

// ---------------------------------------------------------------------------
// Cut point
// ---------------------------------------------------------------------------

/**
 * Where to cut the wire prompt so roughly `keepRecentTokens` stay verbatim.
 *
 * Prefers the nearest message at or after the budget point that is not a tool
 * result, so a tool result is never orphaned from its tool call. When the
 * trailing tool results alone exceed the budget, it falls back to the owning
 * assistant message (at or before that point) — mirroring pi, which keeps the
 * call and its results together rather than dropping the call.
 */
function findWireCutIndex(
  messages: readonly ModelMessage[],
  startIndex: number,
  keepRecentTokens: number,
): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    accumulated += estimateCharsToTokens(measureModelMessageChars(messages[i]!));
    if (accumulated < keepRecentTokens) continue;

    for (let candidate = i; candidate < messages.length; candidate++) {
      if (messages[candidate]!.role !== 'tool') return candidate;
    }
    for (let candidate = i; candidate >= startIndex; candidate--) {
      if (messages[candidate]!.role !== 'tool') return candidate;
    }
    return -1;
  }
  return -1;
}

interface WireCompactionPlan {
  /** Index of the first wire message that stays verbatim. */
  cut: number;
  /** Older messages that will be folded into the checkpoint. */
  toSummarize: ModelMessage[];
  /** Wire-history size before compaction, for lifecycle reporting. */
  tokensBefore: number;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Decide whether the prompt needs folding, and where to cut it.
 *
 * The threshold compares the exact prompt size of the step just run — which
 * already includes the system prompt and tool schemas — plus the messages
 * appended since. That is deliberately a different number from the one the
 * lifecycle event reports: the event measures the wire history alone, so its
 * `before` and `after` share a basis.
 */
function planWireCompaction(input: WireCompactionInput): WireCompactionPlan | null {
  const { messages, config } = input;
  const estimatedTokens = input.anchorTokens + estimateCharsToTokens(input.appendedChars);
  if (!exceedsBudget(estimatedTokens, config.contextWindow, config.reserveTokens)) {
    return null;
  }

  const cut = findWireCutIndex(messages, config.summaryMessageCount, config.keepRecentTokens);
  if (cut < 0) return null;
  const toSummarize = messages.slice(config.summaryMessageCount, cut);
  if (toSummarize.length === 0) return null;

  return {
    cut,
    toSummarize,
    tokensBefore: estimateCharsToTokens(measureModelMessagesChars(messages)),
  };
}

/**
 * Summarize the planned range, or return `null` when the checkpoint would be
 * unusable.
 *
 * A truncated or failed summary must not kill a reply that is otherwise
 * healthy: the oversized prompt is still better than no answer at all, and the
 * durable pre-send compaction will retry from the stored transcript next turn.
 */
async function generateWireSummary(
  input: WireCompactionInput,
  plan: WireCompactionPlan,
): Promise<string | null> {
  const { system, prompt } = buildSummaryPrompt(
    serializeWireForSummary(plan.toSummarize),
    input.config.priorSummary,
  );

  try {
    const result = await generateText({
      model: input.model,
      system,
      prompt,
      abortSignal: input.signal,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    });
    const summary = result.text.trim();
    if (result.finishReason !== 'length' && summary) return summary;

    input.onEvent?.({
      phase: 'failed',
      tokensBefore: plan.tokensBefore,
      error: new Error(
        result.finishReason === 'length'
          ? 'Summarization hit the token cap and the checkpoint would be incomplete'
          : 'Summarization returned an empty response',
      ),
    });
    return null;
  } catch (error) {
    console.error('[Lumo] Between-step compaction failed:', error);
    input.onEvent?.({ phase: 'failed', tokensBefore: plan.tokensBefore, error });
    return null;
  }
}

/**
 * Fold the leading wire prompt into a summary when the context is over budget.
 *
 * Runs entirely in memory: the durable checkpoint is written by the caller on
 * the next turn boundary, so a long tool loop can finish inside the window
 * without touching persisted state mid-run.
 */
export async function compactWireMessages(
  input: WireCompactionInput,
): Promise<WireCompactionResult | null> {
  const plan = planWireCompaction(input);
  if (!plan) return null;

  input.onEvent?.({ phase: 'start', tokensBefore: plan.tokensBefore });
  const summary = await generateWireSummary(input, plan);
  if (!summary) return null;

  const summaryMessage: ModelMessage = {
    role: 'user',
    content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX,
  };
  const messages = [summaryMessage, ...input.messages.slice(plan.cut)];
  input.onEvent?.({
    phase: 'end',
    tokensBefore: plan.tokensBefore,
    tokensAfter: estimateCharsToTokens(measureModelMessagesChars(messages)),
  });
  return { messages, summary };
}

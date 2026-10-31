/**
 * Retry policy for a failed model request.
 *
 * Kept pure and out of the hook because the priority order is easy to get
 * wrong and expensive to get wrong: a context-overflow rejection is
 * deterministic, so resending the same prompt can only fail again — it must be
 * answered by folding history, never by the backoff path. Conversely, a
 * transient 502 must not trigger a compaction that would drop history for
 * nothing.
 */

import {
  isContextOverflowError,
  isRetryableCategory,
  type ChatErrorCategory,
} from '@/lib/provider-error';

export type StreamFailureAction =
  /** Fold history once, then retry against the compacted prompt. */
  | { kind: 'recover-overflow' }
  /** Retry the same request after a backoff delay. */
  | { kind: 'retry'; nextAttempt: number }
  /** Surface the error and end the turn. */
  | { kind: 'fail'; nextAttempt: number };

export interface StreamFailureInput {
  error: Error;
  category: ChatErrorCategory;
  /** Zero-based attempt that just failed. */
  attempt: number;
  maxRetries: number;
  /**
   * Whether the failed attempt produced any assistant parts. Restarting after
   * completed tool steps would re-run calls that already had side effects, so
   * overflow recovery is only safe when nothing was produced.
   */
  producedParts: boolean;
  compactionEnabled: boolean;
  overflowRecoveryAttempted: boolean;
}

/** Decide what a failed request should do next. */
export function decideStreamFailure(input: StreamFailureInput): StreamFailureAction {
  const nextAttempt = input.attempt + 1;
  const overflow = isContextOverflowError(input.error);

  if (
    overflow &&
    !input.overflowRecoveryAttempted &&
    input.compactionEnabled &&
    !input.producedParts
  ) {
    return { kind: 'recover-overflow' };
  }

  // An overflow that could not be recovered is still deterministic: spending
  // the backoff budget on the same oversized prompt cannot help.
  if (!overflow && isRetryableCategory(input.category) && nextAttempt <= input.maxRetries) {
    return { kind: 'retry', nextAttempt };
  }

  return { kind: 'fail', nextAttempt };
}

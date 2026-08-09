/**
 * Auto-retry policy for an assistant turn that failed recoverably.
 *
 * These numbers used to live in `store/useChatStream.ts`, while the error card's
 * "Retrying 1/3" copy read a second, independently declared `MAX_RETRIES` in
 * `components/chat/ChatMessageList.tsx`. Nothing tied the two together, so
 * raising the limit in one place would have left the UI counting towards a
 * different number than the loop actually retried to.
 *
 * Which failures are eligible at all is a separate question, answered by
 * `isRetryableCategory` in `lib/provider-error.ts`: a bad key or a depleted
 * account fails identically on every attempt, so those surface immediately
 * instead of spending the backoff first.
 */

/** How many automatic retries a recoverable failure gets before it surfaces. */
export const MAX_RETRIES = 3;

/** Delay before the first retry. Each further attempt doubles it. */
export const RETRY_BASE_DELAY = 1500;

/**
 * Backoff before the retry that follows `attempt`, in milliseconds.
 *
 * `attempt` is 0-based: `0` is the wait after the initial request failed, so the
 * sequence is 1.5s, 3s, 6s.
 */
export function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY * 2 ** attempt;
}

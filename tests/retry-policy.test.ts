import { describe, it, expect } from 'vitest';
import { MAX_RETRIES, RETRY_BASE_DELAY, retryDelay } from '@/lib/retry-policy';

/**
 * The policy lived in `useChatStream` while the error card's "Retrying 1/3" copy
 * read its own separately declared limit, so the two could disagree about how
 * many attempts there were. Sharing one module makes that structurally
 * impossible; what is still worth pinning is the backoff shape, which is easy to
 * break by treating `attempt` as 1-based and skipping the first delay.
 */

describe('retryDelay', () => {
  it('doubles from the base delay on every attempt', () => {
    expect(retryDelay(0)).toBe(RETRY_BASE_DELAY);
    expect(retryDelay(1)).toBe(RETRY_BASE_DELAY * 2);
    expect(retryDelay(2)).toBe(RETRY_BASE_DELAY * 4);
  });

  it('starts waiting after the first failure rather than skipping it', () => {
    // `attempt` is 0-based: the delay before retry #1 is the base delay, not
    // double it. Off by one here doubles every wait the user sits through.
    expect(retryDelay(0)).toBeLessThan(retryDelay(1));
    expect(retryDelay(0)).toBe(1500);
  });

  it('covers every attempt the loop will make', () => {
    // Guards against a future MAX_RETRIES raise outrunning the backoff helper.
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      expect(Number.isFinite(retryDelay(attempt))).toBe(true);
      expect(retryDelay(attempt)).toBeGreaterThan(0);
    }
  });
});

/**
 * Lifecycle of one assistant turn.
 *
 * Owns the three things that make a run cancellable and stale-safe: the abort
 * controller, a validity flag, and the retry timer. The orchestrator asks
 * `isCurrent()` before mutating shared state; `stop()` makes every pending
 * callback a no-op and clears the timer.
 *
 * Kept free of React so the turn runner can be exercised without a hook.
 */
export class TurnSession {
  readonly controller = new AbortController();
  private current = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Whether this turn still owns the UI.
   *
   * Deliberately ignores the abort signal: a user Stop aborts the request but
   * the abort path still has to settle the turn (persist the partial reply and
   * swap the bubble for the saved message). Only `invalidate`/`dispose` drop
   * ownership.
   */
  isCurrent(): boolean {
    return this.current;
  }

  /** Make pending callbacks inert without aborting a live request. */
  invalidate(): void {
    this.current = false;
    this.clearRetry();
  }

  /**
   * Abort the live request but keep ownership: `chatStream` routes the abort
   * into `onFinish('aborted')`, and that terminal callback must be allowed to
   * persist and settle the UI.
   */
  abort(): void {
    this.clearRetry();
    this.controller.abort();
  }

  /** Hard drop: abort the request and make every pending callback inert. */
  dispose(): void {
    this.current = false;
    this.clearRetry();
    this.controller.abort();
  }

  /**
   * Run `fn` after `delayMs`, unless the session stopped in the meantime.
   * A later schedule replaces the previous timer: a turn has at most one retry
   * pending at a time.
   */
  schedule(fn: () => void, delayMs: number): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current) fn();
    }, delayMs);
  }

  hasPendingRequest(): boolean {
    return this.current && !this.controller.signal.aborted;
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

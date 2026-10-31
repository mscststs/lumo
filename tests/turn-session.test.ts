import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnSession } from '@/store/turn/session';

/**
 * The distinction these tests pin: aborting a live request must not make its
 * terminal callback stale, because that callback is what persists the partial
 * reply and settles the UI. Only `invalidate`/`dispose` drop ownership.
 */

describe('TurnSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('owns the turn until invalidated', () => {
    const session = new TurnSession();
    expect(session.isCurrent()).toBe(true);
    session.invalidate();
    expect(session.isCurrent()).toBe(false);
    expect(session.signal.aborted).toBe(false);
  });

  it('aborts the request but keeps ownership for the terminal callback', () => {
    const session = new TurnSession();
    session.abort();
    expect(session.signal.aborted).toBe(true);
    expect(session.isCurrent()).toBe(true);
    expect(session.hasPendingRequest()).toBe(false);
  });

  it('dispose aborts and drops ownership', () => {
    const session = new TurnSession();
    session.dispose();
    expect(session.signal.aborted).toBe(true);
    expect(session.isCurrent()).toBe(false);
  });

  it('runs a scheduled retry only while the turn is current', () => {
    const session = new TurnSession();
    const first = vi.fn();
    session.schedule(first, 100);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalledTimes(1);

    const dropped = vi.fn();
    session.schedule(dropped, 100);
    session.invalidate();
    vi.advanceTimersByTime(100);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('replaces a pending retry instead of stacking them', () => {
    const session = new TurnSession();
    const first = vi.fn();
    const second = vi.fn();
    session.schedule(first, 100);
    session.schedule(second, 100);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

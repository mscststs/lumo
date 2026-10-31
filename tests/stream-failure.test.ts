import { describe, it, expect } from 'vitest';
import { decideStreamFailure, type StreamFailureInput } from '@/lib/stream-failure';

/**
 * Priority order matters: overflow is deterministic and must be answered by a
 * single compaction, while a transient failure must not drop history. These
 * tests pin both directions.
 */

const OVERFLOW = new Error('context_length_exceeded: prompt is too long');
const TRANSIENT = new Error('502 bad gateway');

function input(overrides: Partial<StreamFailureInput> = {}): StreamFailureInput {
  return {
    error: TRANSIENT,
    category: 'server',
    attempt: 0,
    maxRetries: 3,
    producedParts: false,
    compactionEnabled: true,
    overflowRecoveryAttempted: false,
    ...overrides,
  };
}

describe('decideStreamFailure', () => {
  it('recovers an overflow by compacting instead of backing off', () => {
    expect(decideStreamFailure(input({ error: OVERFLOW, category: 'unknown' }))).toEqual({
      kind: 'recover-overflow',
    });
  });

  it('refuses to recover after tool parts were produced', () => {
    // Restarting the turn would re-run tool calls that already had effects.
    const action = decideStreamFailure(
      input({ error: OVERFLOW, category: 'unknown', producedParts: true }),
    );
    expect(action.kind).toBe('fail');
  });

  it('recovers only once per turn', () => {
    const action = decideStreamFailure(
      input({ error: OVERFLOW, category: 'unknown', overflowRecoveryAttempted: true }),
    );
    expect(action.kind).toBe('fail');
  });

  it('does not compact when the user disabled it', () => {
    const action = decideStreamFailure(
      input({ error: OVERFLOW, category: 'unknown', compactionEnabled: false }),
    );
    expect(action.kind).toBe('fail');
  });

  it('never retries an overflow through the backoff path', () => {
    // Even on the first attempt, an overflow is not a transient failure.
    const action = decideStreamFailure(
      input({ error: OVERFLOW, category: 'unknown', producedParts: true }),
    );
    expect(action).toEqual({ kind: 'fail', nextAttempt: 1 });
  });

  it('retries transient failures until the budget is spent', () => {
    expect(decideStreamFailure(input())).toEqual({ kind: 'retry', nextAttempt: 1 });
    expect(decideStreamFailure(input({ attempt: 2 }))).toEqual({
      kind: 'retry',
      nextAttempt: 3,
    });
    expect(decideStreamFailure(input({ attempt: 3 }))).toEqual({
      kind: 'fail',
      nextAttempt: 4,
    });
  });

  it('does not retry deterministic categories', () => {
    for (const category of ['auth', 'quota', 'storage'] as const) {
      expect(decideStreamFailure(input({ category })).kind).toBe('fail');
    }
  });
});

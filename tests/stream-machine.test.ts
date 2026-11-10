import { describe, it, expect } from 'vitest';
import {
  initialStreamState,
  selectStreamingMessage,
  streamReducer,
  type StreamState,
} from '@/store/stream-machine';
import type { AssistantTurn } from '@/lib/conversation-turn';
import type { ChatMessagePart } from '@/types';

/**
 * Every transition used to be a loose group of `setState` calls scattered across
 * the hook. These tests pin the members of each group, which is the only way to
 * catch a spinner that survives a crash or an error that outlives its attempt.
 */

const TURN: AssistantTurn = { id: 'turn-1', timestamp: 1000 };
const TEXT: ChatMessagePart[] = [{ type: 'text', text: 'hello', state: 'done' }];

function streamingState(overrides: Partial<StreamState> = {}): StreamState {
  return {
    ...initialStreamState,
    isStreaming: true,
    turn: TURN,
    parts: TEXT,
    ...overrides,
  };
}

describe('streamReducer', () => {
  it('starts a fresh turn with nothing carried over, already streaming', () => {
    const state = streamReducer(
      { ...streamingState(), isCompacting: true, error: { message: 'x', category: 'server' } },
      { type: 'turn/start' },
    );
    // Sending enters the streaming phase immediately: Stop is available and the
    // list shows its "thinking" row before the first token arrives.
    expect(state).toEqual({ ...initialStreamState, isStreaming: true });
  });

  it('leaves the streaming phase when the turn settles', () => {
    const started = streamReducer(initialStreamState, { type: 'turn/start' });
    const settled = streamReducer(
      { ...started, turn: TURN, parts: TEXT },
      { type: 'turn/settled' },
    );
    expect(settled.isStreaming).toBe(false);
    expect(settled).toEqual(initialStreamState);
  });

  it('resumes with the streamed parts and turn identity intact', () => {
    const state = streamReducer(streamingState(), { type: 'turn/resume', resume: true });
    expect(state.isStreaming).toBe(true);
    expect(state.turn).toBe(TURN);
    expect(state.parts).toBe(TEXT);
    expect(state.error).toBeNull();
    expect(state.liveUsage).toBeNull();
  });

  it('restarts from scratch when there is no snapshot to resume', () => {
    const state = streamReducer(streamingState(), { type: 'turn/resume', resume: false });
    expect(state.turn).toBeNull();
    expect(state.parts).toEqual([]);
  });

  it('records the allocated turn identity', () => {
    const state = streamReducer(initialStreamState, { type: 'turn/begin', turn: TURN });
    expect(state.turn).toBe(TURN);
  });

  it('replaces the metrics pair instead of mixing numbers across steps', () => {
    const measured = streamReducer(streamingState(), {
      type: 'metrics',
      metrics: { step: 0, ttftMs: 1_200, tps: 45 },
    });
    expect(measured.liveMetrics).toEqual({ step: 0, ttftMs: 1_200, tps: 45 });

    // A new step's first event has its own TTFT and no speed yet. The previous
    // step's rate must not survive next to it — that pair never existed.
    const warming = streamReducer(measured, {
      type: 'metrics',
      metrics: { step: 1, ttftMs: 900, tps: null },
    });
    expect(warming.liveMetrics).toEqual({ step: 1, ttftMs: 900, tps: null });

    const swapped = streamReducer(warming, {
      type: 'metrics',
      metrics: { step: 1, ttftMs: 900, tps: 52 },
    });
    expect(swapped.liveMetrics).toEqual({ step: 1, ttftMs: 900, tps: 52 });
  });

  it('publishes the first step before any speed exists', () => {
    const state = streamReducer(streamingState(), {
      type: 'metrics',
      metrics: { step: 0, ttftMs: 800, tps: null },
    });
    expect(state.liveMetrics).toEqual({ step: 0, ttftMs: 800, tps: null });
  });

  it('clears live metrics with the context anchor on every teardown', () => {
    const live = {
      ...streamingState(),
      liveUsage: { usage: {} as never, coveredPartCount: 1 },
      liveMetrics: { step: 0, ttftMs: 800, tps: 40 },
    };
    for (const action of [
      { type: 'turn/resume', resume: true } as const,
      { type: 'turn/stopped' } as const,
      { type: 'turn/crashed', error: { message: 'x', category: 'server' }, clearParts: false } as const,
    ]) {
      const next = streamReducer(live, action);
      expect(next.liveUsage).toBeNull();
      expect(next.liveMetrics).toBeNull();
    }
  });

  it('settles into the idle state', () => {
    const state = streamReducer(
      { ...streamingState(), isCompacting: true, liveUsage: { usage: {} as never, coveredPartCount: 1 } },
      { type: 'turn/settled' },
    );
    expect(state).toEqual(initialStreamState);
  });

  it('stops the spinner but keeps the partial reply until it is persisted', () => {
    const state = streamReducer(
      { ...streamingState(), isCompacting: true, error: { message: 'x', category: 'server' } },
      { type: 'turn/stopped' },
    );
    expect(state.isStreaming).toBe(false);
    expect(state.isCompacting).toBe(false);
    expect(state.parts).toBe(TEXT);
    expect(state.turn).toBe(TURN);
    expect(state.error).toBeNull();
  });

  it('clears the turn identity on a crash and can drop the partial reply', () => {
    const error = { message: 'boom', category: 'unknown' as const };
    const kept = streamReducer(streamingState(), {
      type: 'turn/crashed',
      error,
      clearParts: false,
    });
    expect(kept.turn).toBeNull();
    expect(kept.parts).toBe(TEXT);
    expect(kept.isStreaming).toBe(false);
    expect(kept.error).toBe(error);

    const dropped = streamReducer(streamingState(), {
      type: 'turn/crashed',
      error,
      clearParts: true,
    });
    expect(dropped.parts).toEqual([]);
  });

  it('keeps streaming while a retry is pending', () => {
    const error = { message: '502', category: 'server' as const };
    const state = streamReducer(streamingState(), {
      type: 'retrying',
      error,
      attempt: 2,
      parts: TEXT,
    });
    expect(state.isStreaming).toBe(true);
    expect(state.isRetrying).toBe(true);
    expect(state.retryAttempt).toBe(2);
    expect(state.error).toBe(error);
  });

  it('retracts the retry notice once the retried request produces output', () => {
    const error = { message: '502', category: 'server' as const };
    const retrying = streamReducer(streamingState(), {
      type: 'retrying',
      error,
      attempt: 2,
      parts: TEXT,
    });
    const recovered = streamReducer(retrying, { type: 'retry/recovered' });
    // The turn keeps streaming — only the failure it recovered from is dropped,
    // so the card cannot outlive the error under a reply that is now arriving.
    expect(recovered.isStreaming).toBe(true);
    expect(recovered.isRetrying).toBe(false);
    expect(recovered.retryAttempt).toBe(0);
    expect(recovered.error).toBeNull();
    expect(recovered.parts).toBe(TEXT);
  });

  it('ends the turn when the failure is final', () => {
    const error = { message: '401', category: 'auth' as const };
    const state = streamReducer(streamingState(), {
      type: 'failed',
      error,
      attempt: 4,
      parts: TEXT,
    });
    expect(state.isStreaming).toBe(false);
    expect(state.isRetrying).toBe(false);
    expect(state.retryAttempt).toBe(4);
    expect(state.error).toBe(error);
  });

  it('marks overflow recovery without losing the stream phase', () => {
    const error = { message: 'context_length_exceeded', category: 'unknown' as const };
    const recovering = streamReducer(
      { ...streamingState(), error, retryAttempt: 2 },
      { type: 'overflow/recovering' },
    );
    expect(recovering.isStreaming).toBe(true);
    expect(recovering.isCompacting).toBe(true);
    expect(recovering.isRetrying).toBe(true);
    // The fold is the recovery now: the failure card must not sit behind it with
    // an inert Retry button for the whole summarization.
    expect(recovering.error).toBeNull();
    expect(recovering.retryAttempt).toBe(0);

    const recovered = streamReducer(recovering, { type: 'overflow/recovered' });
    expect(recovered.isStreaming).toBe(true);
    expect(recovered.isCompacting).toBe(false);
    expect(recovered.isRetrying).toBe(false);
    expect(recovered.liveUsage).toBeNull();
  });

  it('surfaces the original error when overflow recovery cannot help', () => {
    const error = { message: 'context_length_exceeded', category: 'unknown' as const };
    const state = streamReducer(
      streamReducer(streamingState(), { type: 'overflow/recovering' }),
      { type: 'overflow/failed', error },
    );
    expect(state.isStreaming).toBe(false);
    expect(state.isCompacting).toBe(false);
    expect(state.isRetrying).toBe(false);
    expect(state.retryAttempt).toBe(0);
    expect(state.error).toBe(error);
  });

  it('sets and clears an error without changing the phase', () => {
    const error = { message: 'persist failed', category: 'storage' as const };
    const set = streamReducer(streamingState(), { type: 'error', error });
    expect(set.error).toBe(error);
    expect(set.isStreaming).toBe(true);
    expect(streamReducer(set, { type: 'error', error: null }).error).toBeNull();
  });
});

describe('selectStreamingMessage', () => {
  it('returns null before a turn identity or renderable content exists', () => {
    expect(selectStreamingMessage(null, TEXT)).toBeNull();
    expect(selectStreamingMessage(TURN, [])).toBeNull();
    expect(
      selectStreamingMessage(TURN, [{ type: 'text', text: '', state: 'streaming' }]),
    ).toBeNull();
  });

  it('shapes the in-flight turn as a real assistant message', () => {
    expect(selectStreamingMessage(TURN, TEXT)).toEqual({
      id: 'turn-1',
      timestamp: 1000,
      role: 'assistant',
      parts: TEXT,
    });
  });
});

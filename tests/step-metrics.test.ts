import { describe, it, expect } from 'vitest';
import {
  StepCharMeter,
  StepTimingRecorder,
  countCjkChars,
  estimateDecodeTokens,
  formatTps,
  formatTtft,
  stepThroughput,
  tokensPerSecond,
  type StepMetrics,
} from '@/lib/step-metrics';
import type { ChatMessagePart } from '@/types';

function text(value: string): ChatMessagePart {
  return { type: 'text', text: value, state: 'streaming' };
}

describe('estimateDecodeTokens', () => {
  it('measures CJK characters as roughly one token each', () => {
    // 6 Chinese characters: 6 tokens, not ceil(6/4) = 2.
    expect(countCjkChars('你好世界测试')).toBe(6);
    expect(estimateDecodeTokens(6, 6)).toBe(6);
  });

  it('measures latin text at four characters per token', () => {
    expect(estimateDecodeTokens(400, 0)).toBe(100);
  });

  it('rounds once on the total, never per delta', () => {
    // Per-delta ceil would give 4 * ceil(1/4) = 4; the correct total is 1.
    expect(estimateDecodeTokens(4, 0)).toBe(1);
  });

  it('is zero for empty output', () => {
    expect(estimateDecodeTokens(0, 0)).toBe(0);
  });
});

describe('StepCharMeter', () => {
  it('counts only the appended tail of each part', () => {
    const meter = new StepCharMeter();
    expect(meter.add([text('hello')])).toBe(5);
    expect(meter.add([text('hello world')])).toBe(6);
    expect(meter.add([text('hello world')])).toBe(0);
    expect(meter.totalChars).toBe(11);
    expect(meter.cjkChars).toBe(0);
  });

  it('tracks CJK characters incrementally', () => {
    const meter = new StepCharMeter();
    meter.add([text('你好')]);
    meter.add([text('你好，世界')]);
    expect(meter.totalChars).toBe(5);
    // The full-width comma is punctuation, not a CJK character.
    expect(meter.cjkChars).toBe(4);
    expect(estimateDecodeTokens(meter.totalChars, meter.cjkChars)).toBe(5);
  });

  it('counts streamed tool arguments, like pi counts tool-call deltas', () => {
    const meter = new StepCharMeter();
    expect(meter.add([tool('{"value":')])).toBe(9);
    expect(meter.add([tool('{"value":"x"}')])).toBe(4);
    // `rawInput` disappears once the call completes; the counted characters
    // must stay in the total.
    expect(meter.add([tool()])).toBe(0);
    expect(meter.totalChars).toBe(13);
  });

  it('rescans when a part list is rebuilt with shorter text', () => {
    const meter = new StepCharMeter();
    meter.add([text('hello world')]);
    // A retry inside the step rebuilds the parts from scratch.
    expect(meter.add([text('hey')])).toBe(0);
    expect(meter.totalChars).toBe(3);
  });
});

describe('formatting', () => {
  it('formats TTFT in the unit that keeps the number short', () => {
    expect(formatTtft(850)).toBe('850ms');
    expect(formatTtft(1234)).toBe('1.2s');
  });

  it('drops decimals once the rate is large', () => {
    expect(formatTps(42.14)).toBe('42.1 T/s');
    expect(formatTps(120.4)).toBe('120 T/s');
  });
});

describe('stepThroughput', () => {
  it('divides the exact output tokens by the whole call', () => {
    expect(stepThroughput({ outputTokens: 200, generationMs: 4000 })).toBe(50);
  });

  it('is unavailable without a generation window or output tokens', () => {
    expect(stepThroughput({ outputTokens: 200, generationMs: 0 })).toBeNull();
    expect(stepThroughput({ outputTokens: 0, generationMs: 1000 })).toBeNull();
    expect(stepThroughput({ outputTokens: 10 })).toBeNull();
  });

  it('does not floor the window', () => {
    // A single burst is debounced away, not rescaled.
    expect(stepThroughput({ outputTokens: 40, generationMs: 200 })).toBeNull();
    // Past the debounce the real window is used, however short it is.
    expect(stepThroughput({ outputTokens: 40, generationMs: 250 })).toBe(160);
    expect(stepThroughput({ outputTokens: 321, generationMs: 427 })).toBeCloseTo(
      751.76,
      2,
    );
    expect(stepThroughput({ outputTokens: 40, generationMs: 1_000 })).toBe(40);
    expect(stepThroughput({ outputTokens: 40, generationMs: 2_000 })).toBe(20);
  });

  it('averages a buffered burst over the wait that preceded it', () => {
    // 5000 tokens handed over in one chunk after a 3s wait is not 20000 T/s:
    // the denominator is the whole call, so it reads ~1538 T/s.
    expect(stepThroughput({ outputTokens: 5000, generationMs: 3_250 })).toBeCloseTo(
      1538.46,
      2,
    );
  });
});

function tool(rawInput?: string): ChatMessagePart {
  return (
    rawInput === undefined
      ? {
          type: 'tool-echo',
          toolCallId: 'call-1',
          state: 'input-available',
          input: { value: 'x' },
        }
      : {
          type: 'tool-echo',
          toolCallId: 'call-1',
          state: 'input-streaming',
          rawInput,
        }
  ) as ChatMessagePart;
}

describe('StepTimingRecorder', () => {
  /** Deterministic clock: the policy is time-based, so time is injected. */
  function recorder(step = 0) {
    let now = 1_000;
    const events: StepMetrics[] = [];
    const instance = new StepTimingRecorder(
      step,
      (metrics) => events.push(metrics),
      () => now,
    );
    return {
      events,
      advance: (ms: number) => {
        now += ms;
      },
      instance,
    };
  }

  it('publishes TTFT on the first output, withholds speed until debounced', () => {
    const r = recorder();
    r.advance(120);
    r.instance.observe([text('a')]);

    expect(r.events).toEqual([{ step: 0, ttftMs: 120, tps: null }]);

    r.advance(100); // 220ms from the request: still under the 250ms debounce
    r.instance.observe([text('abcd')]);
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 120, tps: null });
  });

  it('emits the running average at most every 100ms', () => {
    const r = recorder();
    r.advance(100);
    r.instance.observe([text('a')]); // first output at 100ms
    expect(r.events).toHaveLength(1);

    // 230ms from the request start: the debounce window is still open, so the
    // sample reports no speed.
    r.advance(130);
    r.instance.observe([text('abcdefg')]);

    // 500ms from the request start: 8 chars → 2 tokens → 2 / 0.5s = 4 T/s.
    r.advance(270);
    r.instance.observe([text('abcdefgh')]);
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 100, tps: 4 });
  });

  it('charges the wait before the burst to the live average', () => {
    const r = recorder();
    r.advance(400);
    // A provider that holds the stream for 400ms and then flushes 400 CJK
    // tokens in its opening chunk: the numerator is the whole generation, and
    // the denominator is the whole call — the wait is charged, not skipped.
    r.instance.observe([text('思'.repeat(400))]);
    // The very first sample is already honest: 400 tokens over the 400ms that
    // preceded them, not over the duration of the chunk.
    expect(r.events[0]).toEqual({ step: 0, ttftMs: 400, tps: 400 / 0.4 });
    r.advance(300);
    r.instance.observe([text('思'.repeat(404))]); // 404 tokens / 0.7s

    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 400, tps: 404 / 0.7 });

    const timing = r.instance.finish(410);
    expect(timing).toEqual({ ttftMs: 400, generationMs: 700 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(410 / 0.7, 5);
  });

  it('rates a whole tool call once its end is known', () => {
    const r = recorder();
    r.advance(80);
    // `input-available` without `rawInput`: the arguments arrived in one chunk.
    // The arrival is still the first output, so TTFT exists — but it adds no
    // characters to the meter, so the live average has no numerator.
    r.instance.observe([tool()]);
    expect(r.events).toEqual([{ step: 0, ttftMs: 80, tps: null }]);

    r.advance(300);
    r.instance.markModelCallEnd();

    // How the output arrived is not part of the arithmetic: 40 tokens over the
    // whole 380ms call.
    expect(r.instance.finish(40)).toEqual({ ttftMs: 80, generationMs: 380 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(40 / 0.38, 5);
  });

  it('ends the window at the model call, never at the tool run', () => {
    const r = recorder();
    r.advance(100);
    r.instance.observe([text('hello')]);
    r.advance(300);
    r.instance.observe([text('hello'), tool()]); // args arrived whole at 400ms
    r.instance.markModelCallEnd(); // the SDK's `onLanguageModelCallEnd`

    // The tool now runs for as long as it takes; the window is already closed.
    r.advance(5_000);
    r.instance.observe([
      text('hello'),
      { ...tool(), state: 'output-available' } as ChatMessagePart,
    ]);

    expect(r.instance.finish(100)).toEqual({
      ttftMs: 100,
      generationMs: 400,
    });
    // 100 tokens over the whole 400ms call, TTFT included.
    expect(r.events.at(-1)!.tps).toBeCloseTo(250, 5);
  });

  it('reports a speed for a tool call that streamed past the debounce', () => {
    const r = recorder();
    r.advance(50);
    r.instance.observe([tool('{"value":')]); // TTFT at the first argument delta
    r.advance(400);
    r.instance.observe([tool('{"value":"x"}')]); // 13 chars → 4 tokens
    r.instance.markModelCallEnd();

    expect(r.events[0]).toEqual({ step: 0, ttftMs: 50, tps: null });
    // 4 estimated tokens over the 450ms since the request went out.
    expect(r.events.at(-1)!.tps).toBeCloseTo(4 / 0.45, 5);

    const timing = r.instance.finish(40);

    // The provider's exact count (which includes the tool arguments) over the
    // same window.
    expect(timing).toEqual({ ttftMs: 50, generationMs: 450 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(40 / 0.45, 5);
  });

  it('suppresses the final rate below the debounce', () => {
    const r = recorder();
    r.advance(10);
    r.instance.observe([tool('{"a":1}')]);
    r.advance(20);
    r.instance.observe([tool('{"a":1} ')]); // one more character, 20ms window

    const timing = r.instance.finish(40);

    // The whole call is a single burst, not a rate — the ledger must show
    // nothing rather than 40 tokens / 30ms = 1333 T/s.
    expect(timing).toEqual({ ttftMs: 10, generationMs: 30 });
    expect(stepThroughput({ outputTokens: 40, generationMs: 30 })).toBeNull();
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 10, tps: null });
  });

  it('records a sub-debounce window without inventing a rate', () => {
    const r = recorder();
    r.advance(50);
    r.instance.observe([text('all at once')]);

    // The window is request start → call end; here both are the same instant,
    // so the whole call is one burst.
    expect(r.instance.finish(50)).toEqual({ ttftMs: 50, generationMs: 50 });
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 50, tps: null });
  });

  it('records the window from the request start, not the first delta', () => {
    const r = recorder();
    r.advance(120);
    r.instance.observe([text('hello')]);
    r.advance(1_000);
    r.instance.observe([text('hello world')]);

    const timing = r.instance.finish(20);

    // TTFT = 120ms, streaming = 1000ms; the window is the full 1120ms.
    expect(timing).toEqual({
      ttftMs: 120,
      generationMs: 1_120,
    });
    expect(r.events.at(-1)!.tps).toBeCloseTo(20 / 1.12, 5);
  });

  it('falls back to the character estimate when the provider omits usage', () => {
    const r = recorder(1);
    r.advance(40);
    r.instance.observe([text('hello')]); // 5 latin chars → 2 tokens
    r.advance(400);
    r.instance.observe([text('hello world!!')]); // 13 chars → 4 tokens

    const timing = r.instance.finish(0);

    // 4 estimated tokens over the 440ms since the request went out.
    expect(timing).toEqual({ ttftMs: 40, generationMs: 440 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(4 / 0.44, 5);
  });
});

describe('tokensPerSecond', () => {
  it('is the single formula shared by live and final values', () => {
    expect(tokensPerSecond(50, 1_000)).toBe(50);
    expect(tokensPerSecond(50, 0)).toBeNull();
    expect(tokensPerSecond(0, 1_000)).toBeNull();
    expect(tokensPerSecond(50, undefined)).toBeNull();
  });
});

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
  it('derives output speed from exact tokens and the decode window', () => {
    expect(stepThroughput({ outputTokens: 200, decodeMs: 4000 })).toBe(50);
  });

  it('is unavailable without a decode window or output tokens', () => {
    expect(stepThroughput({ outputTokens: 200, decodeMs: 0 })).toBeNull();
    expect(stepThroughput({ outputTokens: 0, decodeMs: 1000 })).toBeNull();
    expect(stepThroughput({ outputTokens: 10 })).toBeNull();
  });

  it('does not floor the decode window, exactly like pi', () => {
    // A single burst is debounced away, not rescaled.
    expect(stepThroughput({ outputTokens: 40, decodeMs: 200 })).toBeNull();
    // Past the debounce the real window is used, however short it is.
    expect(stepThroughput({ outputTokens: 40, decodeMs: 250 })).toBe(160);
    expect(stepThroughput({ outputTokens: 321, decodeMs: 427 })).toBeCloseTo(
      751.76,
      2,
    );
    expect(stepThroughput({ outputTokens: 40, decodeMs: 1_000 })).toBe(40);
    expect(stepThroughput({ outputTokens: 40, decodeMs: 2_000 })).toBe(20);
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

    r.advance(130); // 130ms of decode: still under the 250ms debounce
    r.instance.observe([text('abcd')]);
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 120, tps: null });
  });

  it('emits the running average at most every 100ms', () => {
    const r = recorder();
    r.advance(100);
    r.instance.observe([text('a')]); // first output at 100ms
    expect(r.events).toHaveLength(1);

    // 130ms after the first output: the debounce window is still open, so the
    // sample reports no speed.
    r.advance(130);
    r.instance.observe([text('abcdefg')]);

    // 400ms of decode: 8 chars → 2 tokens → 2 / 0.4s = 5 T/s.
    r.advance(270);
    r.instance.observe([text('abcdefgh')]);
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 100, tps: 5 });
  });

  it('counts the whole output, including the burst that arrives at TTFT', () => {
    const r = recorder();
    r.advance(400);
    // A reasoning model that flushes 400 CJK tokens in its opening chunk: the
    // numerator is the whole generation, exactly as pi counts it.
    r.instance.observe([text('思'.repeat(400))]);
    r.advance(300);
    r.instance.observe([text('思'.repeat(404))]); // 404 tokens / 0.3s

    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 400, tps: 404 / 0.3 });

    const timing = r.instance.finish(410);
    expect(timing).toEqual({ ttftMs: 400, decodeMs: 300 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(410 / 0.3, 5);
  });

  it('gives a whole tool call a TTFT but no rate', () => {
    const r = recorder();
    r.advance(80);
    // `input-available` without `rawInput`: the arguments arrived in one chunk,
    // so there is no decode sample to divide by — pi's `addDelta` never fires
    // either. The arrival is still the first output, so TTFT exists.
    r.instance.observe([tool()]);
    expect(r.events).toEqual([{ step: 0, ttftMs: 80, tps: null }]);

    r.advance(300);
    expect(r.instance.finish(40)).toEqual({ ttftMs: 80 });
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 80, tps: null });
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

    expect(r.instance.finish(100)).toEqual({ ttftMs: 100, decodeMs: 300 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(100 / 0.3, 5);
  });

  it('reports a speed for a tool call that streamed past the debounce', () => {
    const r = recorder();
    r.advance(50);
    r.instance.observe([tool('{"value":')]); // TTFT at the first argument delta
    r.advance(400);
    r.instance.observe([tool('{"value":"x"}')]); // 13 chars → 4 tokens
    r.instance.markModelCallEnd();

    expect(r.events[0]).toEqual({ step: 0, ttftMs: 50, tps: null });
    // 4 estimated tokens over 400ms of decode.
    expect(r.events.at(-1)!.tps).toBeCloseTo(10, 5);

    const timing = r.instance.finish(40);

    // The provider's exact count (which includes the tool arguments) over the
    // same window: this is the number pi keeps on the footer.
    expect(timing).toEqual({ ttftMs: 50, decodeMs: 400 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(100, 5);
  });

  it('suppresses the final rate below the debounce, exactly like pi', () => {
    const r = recorder();
    r.advance(10);
    r.instance.observe([tool('{"a":1}')]);
    r.advance(20);
    r.instance.observe([tool('{"a":1} ')]); // one more character, 20ms window

    const timing = r.instance.finish(40);

    // The window is a single burst, not a rate — the ledger must show nothing
    // rather than 40 tokens / 20ms = 2000 T/s.
    expect(timing).toEqual({ ttftMs: 10, decodeMs: 20 });
    expect(stepThroughput({ outputTokens: 40, decodeMs: 20 })).toBeNull();
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 10, tps: null });
  });

  it('has no window when the call ends with the first delta', () => {
    const r = recorder();
    r.advance(50);
    r.instance.observe([text('all at once')]);

    // The window is first delta → call end; here both are the same instant.
    expect(r.instance.finish(50)).toEqual({ ttftMs: 50 });
    expect(r.events.at(-1)).toEqual({ step: 0, ttftMs: 50, tps: null });
  });

  it('divides the exact output tokens by the first delta → end window', () => {
    const r = recorder();
    r.advance(120);
    r.instance.observe([text('hello')]);
    r.advance(1_000);
    r.instance.observe([text('hello world')]);

    const timing = r.instance.finish(20);

    // TTFT = first delta; decode = first delta → call end (1000ms);
    // 20 exact tokens / 1s.
    expect(timing).toEqual({ ttftMs: 120, decodeMs: 1_000 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(20, 5);
  });

  it('falls back to the character estimate when the provider omits usage', () => {
    const r = recorder(1);
    r.advance(40);
    r.instance.observe([text('hello')]); // 5 latin chars → 2 tokens
    r.advance(400);
    r.instance.observe([text('hello world!!')]); // 13 chars → 4 tokens

    const timing = r.instance.finish(0);

    // 4 estimated tokens over 400ms of decode.
    expect(timing).toEqual({ ttftMs: 40, decodeMs: 400 });
    expect(r.events.at(-1)!.tps).toBeCloseTo(10, 5);
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

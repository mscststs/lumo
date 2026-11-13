/**
 * Per-step generation metrics.
 *
 * These tests pin the two things that are easy to get subtly wrong:
 *
 * 1. The live value is published *before* the step ends, so the reply can show
 *    something while it streams.
 * 2. The per-step timings recorded on the usage ledger measure the model call
 *    only — tool execution must never land in the generation window.
 */
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { runAgentLoop } from '@/lib/ai';
import { stepThroughput, type StepMetrics } from '@/lib/step-metrics';

function stream(parts: LanguageModelV4StreamPart[], options: { initialDelayInMs?: number; chunkDelayInMs?: number } = {}) {
  return {
    stream: simulateReadableStream({
      chunks: parts,
      initialDelayInMs: options.initialDelayInMs ?? null,
      chunkDelayInMs: options.chunkDelayInMs ?? null,
    }),
  };
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
} satisfies LanguageModelV4Usage;

const FINISH = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

const TOOL_FINISH = {
  type: 'finish',
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

const PROMPT: ModelMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
];

function textStep(body: string): LanguageModelV4StreamPart[] {
  // Several deltas: a single one lands inside the debounce (the whole call is
  // one burst), which is correctly reported as "not measurable" rather than a
  // rate.
  const size = Math.max(1, Math.ceil(body.length / 4));
  const deltas: LanguageModelV4StreamPart[] = [];
  for (let offset = 0; offset < body.length; offset += size) {
    deltas.push({ type: 'text-delta', id: '0', delta: body.slice(offset, offset + size) });
  }
  return [{ type: 'text-start', id: '0' }, ...deltas, { type: 'text-end', id: '0' }, FINISH];
}

function toolStep(callId: string, toolName = 'echo'): LanguageModelV4StreamPart[] {
  return [
    { type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify({ value: 'x' }) },
    TOOL_FINISH,
  ];
}

/** A step that both speaks and calls a tool — visible output plus a tool wait. */
function textThenToolStep(
  callId: string,
  toolName: string,
): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'working ' },
    { type: 'text-delta', id: '0', delta: 'on it' },
    { type: 'text-end', id: '0' },
    { type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify({ value: 'x' }) },
    TOOL_FINISH,
  ];
}

describe('runAgentLoop metrics', () => {
  it('publishes a live TTFT before the step finishes, then the exact numbers', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        stream(textStep('Hello there, this is a reply.'), {
          initialDelayInMs: 40,
          chunkDelayInMs: 150,
        }),
    });

    const events: StepMetrics[] = [];
    const result = await runAgentLoop({
      model,
      messages: PROMPT,
      onMetrics: (metrics) => events.push(metrics),
    });

    expect(events.length).toBeGreaterThan(0);
    // First publication: TTFT known. Whether it already carries a rate depends
    // on how long the first token took relative to the debounce, so the cadence
    // itself is pinned by the recorder's unit tests (injected clock).
    expect(events[0]!.ttftMs).not.toBeNull();
    expect(events[0]!.ttftMs!).toBeGreaterThan(0);

    const step = result.usage.steps?.[0];
    expect(step?.ttftMs).toBeGreaterThan(0);
    expect(step?.generationMs).toBeGreaterThan(0);

    // The last event carries the step-exact value that also landed on the ledger.
    const last = events.at(-1)!;
    expect(last.ttftMs).toBe(step!.ttftMs);
    // Both sides divide the provider's whole output by the same rounded window
    // (the whole call, TTFT included), so they agree exactly — not just within
    // a rounding tolerance.
    const derived = step!.outputTokens / (step!.generationMs! / 1000);
    expect(last.tps).toBe(derived);
  });

  it('records the generation window for a whole-call tool step too', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const scripted = call++ === 0 ? toolStep('call-1') : textStep('done');
        return stream(scripted, { initialDelayInMs: 10, chunkDelayInMs: 150 });
      },
    });

    const echo = tool({
      description: 'Echoes its input back.',
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ echoed: value }),
    });

    const events: StepMetrics[] = [];
    const result = await runAgentLoop({
      model,
      messages: PROMPT,
      tools: { echo },
      onMetrics: (metrics) => events.push(metrics),
    });

    expect(result.usage.steps).toHaveLength(2);
    // Step 0 is a one-chunk tool call: no argument delta ever streamed, and the
    // window does not care. Its arrival opens TTFT, and the call's end closes a
    // normal generation window — the same measurement a streaming step gets.
    // (Whether that window is long enough to survive the debounce is the
    // unit test's business; 150ms intra-chunk delay is not a stable assertion.)
    expect(result.usage.steps![0]!.ttftMs).toBeGreaterThan(0);
    expect(result.usage.steps![0]!.generationMs).toBeGreaterThan(0);
    // Step 1 generated text deltas, so it has a window and a rate.
    expect(result.usage.steps![1]!.ttftMs).toBeGreaterThan(0);
    expect(result.usage.steps![1]!.generationMs).toBeGreaterThan(0);
    expect(stepThroughput(result.usage.steps![1]!)).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.step))).toEqual(new Set([0, 1]));
  });

  it('reports a speed for a tool call that streamed its arguments', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks:
            call++ === 0
              ? [
                  { type: 'tool-input-start', id: 'call-1', toolName: 'echo' },
                  { type: 'tool-input-delta', id: 'call-1', delta: '{"val' },
                  { type: 'tool-input-delta', id: 'call-1', delta: 'ue":' },
                  { type: 'tool-input-delta', id: 'call-1', delta: '"x' },
                  { type: 'tool-input-delta', id: 'call-1', delta: '"' },
                  { type: 'tool-input-delta', id: 'call-1', delta: '}' },
                  { type: 'tool-input-end', id: 'call-1' },
                  { type: 'tool-call', toolCallId: 'call-1', toolName: 'echo', input: '{"value":"x"}' },
                  TOOL_FINISH,
                ]
              : textStep('done'),
          initialDelayInMs: 20,
          chunkDelayInMs: 90,
        }),
      }),
    });

    const echo = tool({
      description: 'Echoes its input back.',
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ echoed: value }),
    });

    const events: StepMetrics[] = [];
    const result = await runAgentLoop({
      model,
      messages: PROMPT,
      tools: { echo },
      onMetrics: (metrics) => events.push(metrics),
    });

    const step = result.usage.steps![0]!;
    // The arguments themselves streamed across five deltas and the window runs
    // to the end of the call.
    expect(step.generationMs).toBeGreaterThanOrEqual(250);
    expect(stepThroughput(step)).toBeGreaterThan(0);
    expect(events.some((event) => event.step === 0 && event.tps !== null)).toBe(true);
  });

  it('charges a provider hold-open tail to the window', async () => {
    // The arguments arrive in ~8ms, then the provider keeps the response open
    // for 400ms before the finish chunk. pi reads the clock at `message_end`,
    // so that tail is generation time: 200 tokens over ~0.4s, not an instant
    // burst. This is the one place where the window deliberately outlives the
    // last delta.
    const burstUsage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 200, text: 200, reasoning: undefined },
    } satisfies LanguageModelV4Usage;
    const finish = { ...TOOL_FINISH, usage: burstUsage } satisfies LanguageModelV4StreamPart;

    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'tool-input-start', id: 'call-1', toolName: 'echo' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"value":' },
      { type: 'tool-input-delta', id: 'call-1', delta: '"x"}' },
      { type: 'tool-input-end', id: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'echo', input: '{"value":"x"}' },
      finish,
    ];

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            for (const part of chunks.slice(0, -1)) {
              controller.enqueue(part);
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
            controller.enqueue(chunks.at(-1)!);
            controller.close();
          },
        }),
      }),
    });

    const echo = tool({
      description: 'Echoes its input back.',
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ echoed: value }),
    });

    const events: StepMetrics[] = [];
    const result = await runAgentLoop({
      model,
      messages: PROMPT,
      tools: { echo },
      maxSteps: 1,
      onMetrics: (metrics) => events.push(metrics),
    });

    const step = result.usage.steps![0]!;
    expect(step.ttftMs).toBeGreaterThan(0);
    expect(step.generationMs!).toBeGreaterThanOrEqual(250);
    expect(stepThroughput(step)).toBeGreaterThan(0);
    expect(stepThroughput(step)!).toBeLessThan(1_000);
    // The settled event and the ledger tell the same story.
    expect(events.at(-1)!.tps).toBeCloseTo(stepThroughput(step)!, 0);
  });

  it('does not charge tool execution to the generation window', async () => {
    // Generous against CI scheduling noise: the assertion only needs the tool
    // delay to dwarf the model call, not a tight timing bound.
    const TOOL_DELAY_MS = 500;
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // The step speaks before calling the slow tool, so it has a decode
        // window and a rate, while the tool itself runs far longer.
        const scripted =
          call++ === 0 ? textThenToolStep('call-1', 'slow') : textStep('done');
        return stream(scripted, { initialDelayInMs: 10, chunkDelayInMs: 5 });
      },
    });

    const slow = tool({
      description: 'Takes a while.',
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => {
        await new Promise((resolve) => setTimeout(resolve, TOOL_DELAY_MS));
        return { echoed: value };
      },
    });

    const result = await runAgentLoop({ model, messages: PROMPT, tools: { slow } });

    // The first step's model call ended long before its tool did.
    expect(result.usage.steps![0]!.generationMs!).toBeLessThan(TOOL_DELAY_MS - 100);
  });
});

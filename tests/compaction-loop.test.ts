import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { tool } from 'ai';
import { z } from 'zod';
import type { ModelMessage, UIMessage } from 'ai';
import { runAgentLoop, type StepCompactionRequest } from '@/lib/ai';

function stream(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream({
      chunks: parts,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} satisfies LanguageModelV4Usage;

const TOOL_FINISH = {
  type: 'finish',
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

const FINISH = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    FINISH,
  ];
}

function toolStep(callId: string, value: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'tool-call', toolCallId: callId, toolName: 'echo', input: JSON.stringify({ value }) },
    TOOL_FINISH,
  ];
}

const echoTool = tool({
  description: 'Echoes its input back.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ echoed: value }),
});

const SUMMARY = 'SUMMARY-OF-EARLIER-HISTORY';

function promptText(messages: ModelMessage[]): string {
  return JSON.stringify(messages);
}

describe('runAgentLoop between-step compaction', () => {
  it('folds the leading prompt into a summary when over the window', async () => {
    const prompts: ModelMessage[][] = [];
    const generateCalls: ModelMessage[][] = [];
    const usageCounts: number[] = [];
    const events: Array<{ phase: string; tokensBefore?: number; tokensAfter?: number }> = [];
    let streamCall = 0;

    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        const step = streamCall++ === 0 ? toolStep('call_1', 'y'.repeat(8000)) : textStep('done');
        return stream(step);
      },
      doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
        generateCalls.push(options.prompt as unknown as ModelMessage[]);
        return {
          content: [{ type: 'text', text: SUMMARY }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    // A long history so there is something older than the current step to fold.
    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `u${i} ${'a'.repeat(2000)}` });
      history.push({ role: 'assistant', content: `a${i} ${'b'.repeat(2000)}` });
    }

    const { stoppedReason } = await runAgentLoop({
      model,
      messages: history,
      tools: { echo: echoTool },
      // Window is small enough that the appended tool payload trips it, while
      // `keepRecentTokens` is large enough to keep the whole current step.
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      onUsage: (_usage, processedPartCount) => usageCounts.push(processedPartCount),
      onCompaction: (event) => events.push(event),
    });
    expect(stoppedReason).toBe('finished');
    // The part count is what lets the caller add only the delta after the
    // anchor; it must be a stable, growing prefix length.
    expect(usageCounts).toHaveLength(2);
    expect(usageCounts[0]).toBeGreaterThan(0);
    expect(usageCounts[1]).toBeGreaterThanOrEqual(usageCounts[0]!);
    expect(events.map((event) => event.phase)).toEqual(['start', 'end']);
    // Both figures describe the wire history, so they share one basis.
    expect(events[1]!.tokensAfter!).toBeLessThan(events[1]!.tokensBefore!);
    // The summarizer ran exactly once, and it saw only the older history.
    expect(generateCalls).toHaveLength(1);
    expect(promptText(generateCalls[0]!)).toContain('u0');
    expect(promptText(generateCalls[0]!)).not.toContain('echoed');

    // The second request is the compacted prompt: summary + the kept step.
    expect(prompts).toHaveLength(2);
    const compacted = prompts[1]!;
    expect(compacted.length).toBeLessThan(prompts[0]!.length);
    expect(promptText(compacted)).toContain(SUMMARY);
    // The current step's tool call and result survived compaction.
    expect(promptText(compacted)).toContain('echo');
  });

  it('leaves the prompt untouched when compaction is disabled', async () => {
    const prompts: ModelMessage[][] = [];
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        return stream(streamCall++ === 0 ? toolStep('call_1', 'y'.repeat(8000)) : textStep('done'));
      },
    });

    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: { echo: echoTool },
    });

    // No between-step rewrite: the second prompt is the first plus the step.
    expect(prompts[1]!.length).toBeGreaterThan(prompts[0]!.length);
  });

  it('keeps the owning tool call when the trailing results alone exceed the budget', async () => {
    const prompts: ModelMessage[][] = [];
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        return stream(streamCall++ === 0 ? toolStep('call_1', 'y'.repeat(20000)) : textStep('done'));
      },
      doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
        content: [{ type: 'text', text: SUMMARY }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      }),
    });

    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `u${i} ${'a'.repeat(2000)}` });
      history.push({ role: 'assistant', content: `a${i} ${'b'.repeat(2000)}` });
    }

    await runAgentLoop({
      model,
      messages: history,
      tools: { echo: echoTool },
      // Budget smaller than the tool payload, so the cut must fall back to the
      // assistant message that owns it rather than orphaning the tool result.
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 1000,
        summaryMessageCount: 0,
      },
    });

    expect(prompts).toHaveLength(2);
    const compacted = promptText(prompts[1]!);
    expect(compacted).toContain(SUMMARY);
  });

  it('keeps the reply alive when the summarizer fails', async () => {
    const prompts: ModelMessage[][] = [];
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        return stream(streamCall++ === 0 ? toolStep('call_1', 'y'.repeat(8000)) : textStep('done'));
      },
      doGenerate: async () => {
        throw new Error('summarizer down');
      },
    });

    const { stoppedReason } = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: { echo: echoTool },
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
    });

    // The oversized prompt still runs: losing the summary must not lose the
    // answer, especially after tool calls that already had side effects.
    expect(stoppedReason).toBe('finished');
    expect(prompts).toHaveLength(2);
  });
});

describe('runAgentLoop durable between-step compaction', () => {
  it('rebuilds the prompt from the projection and preserves the live tail', async () => {
    const prompts: ModelMessage[][] = [];
    let streamCall = 0;
    // Big enough that the appended step alone crosses the tiny window.
    const tailPayload = `tail-value-${'y'.repeat(400)}`;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        return stream(streamCall++ === 0 ? toolStep('call_1', tailPayload) : textStep('done'));
      },
    });

    const history: ModelMessage[] = [
      { role: 'user', content: 'OLD-HISTORY question' },
      { role: 'assistant', content: 'OLD-HISTORY answer' },
      { role: 'user', content: 'CURRENT-QUESTION' },
    ];
    const requests: StepCompactionRequest[] = [];

    const { stoppedReason } = await runAgentLoop({
      model,
      messages: history,
      tools: { echo: echoTool },
      compaction: {
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      onCompactBeforeStep: async (request) => {
        requests.push(request);
        return {
          uiMessages: [
            {
              id: 'summary',
              role: 'user',
              parts: [{ type: 'text', text: 'DURABLE-SUMMARY', state: 'done' }],
            },
            {
              id: 'u-current',
              role: 'user',
              parts: [{ type: 'text', text: 'CURRENT-QUESTION', state: 'done' }],
            },
          ] as unknown as UIMessage[],
          priorSummary: 'DURABLE-SUMMARY',
        };
      },
    });

    expect(stoppedReason).toBe('finished');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tokensBefore).toBeGreaterThan(90);

    const second = JSON.stringify(prompts[1]);
    expect(second).toContain('DURABLE-SUMMARY');
    expect(second).toContain('CURRENT-QUESTION');
    expect(second).not.toContain('OLD-HISTORY');
    // The live tail — the tool call and its result — survives the rebuild.
    expect(second).toContain('echo');
    expect(second).toContain('tail-value-');
  });

  it('does not ask the store when the prompt is under budget', async () => {
    const requests: StepCompactionRequest[] = [];
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => stream(streamCall++ === 0 ? toolStep('call_1', 'x') : textStep('done')),
    });

    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: { echo: echoTool },
      compaction: {
        contextWindow: 1_000_000,
        reserveTokens: 100,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      onCompactBeforeStep: async (request) => {
        requests.push(request);
        return null;
      },
    });

    expect(requests).toHaveLength(0);
  });

  it('falls back to the in-memory fold when the durable fold finds nothing', async () => {
    const prompts: ModelMessage[][] = [];
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        return stream(streamCall++ === 0 ? toolStep('call_1', 'y'.repeat(8000)) : textStep('done'));
      },
      doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
        content: [{ type: 'text', text: SUMMARY }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      }),
    });

    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `u${i} ${'a'.repeat(2000)}` });
      history.push({ role: 'assistant', content: `a${i} ${'b'.repeat(2000)}` });
    }

    await runAgentLoop({
      model,
      messages: history,
      tools: { echo: echoTool },
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      onCompactBeforeStep: async () => null,
    });

    expect(prompts).toHaveLength(2);
    expect(promptText(prompts[1]!)).toContain(SUMMARY);
  });
});

describe('durable and in-memory compaction do not mix', () => {
  it('disables the durable path once an in-memory fold has rewritten the prompt', async () => {
    const prompts: ModelMessage[][] = [];
    const requests: StepCompactionRequest[] = [];
    const generateCalls: ModelMessage[][] = [];
    let streamCall = 0;

    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        const step =
          streamCall++ < 2
            ? toolStep(`call_${streamCall}`, 'y'.repeat(8000))
            : textStep('done');
        return stream(step);
      },
      doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
        generateCalls.push(options.prompt as unknown as ModelMessage[]);
        return {
          content: [{ type: 'text', text: SUMMARY }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `u${i} ${'a'.repeat(2000)}` });
      history.push({ role: 'assistant', content: `a${i} ${'b'.repeat(2000)}` });
    }

    await runAgentLoop({
      model,
      messages: history,
      tools: { echo: echoTool },
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      // The durable owner has nothing to fold, so the loop falls back to the
      // in-memory fold — and must not try a durable rebuild afterwards, which
      // would append a second copy of the live tail.
      onCompactBeforeStep: async (request) => {
        requests.push(request);
        return null;
      },
    });

    expect(prompts).toHaveLength(3);
    expect(requests).toHaveLength(1);
    expect(generateCalls).toHaveLength(2);
  });

  it('ignores the durable callback on a resumed prompt', async () => {
    const requests: StepCompactionRequest[] = [];
    const generateCalls: ModelMessage[][] = [];
    let streamCall = 0;

    const model = new MockLanguageModelV4({
      doStream: async () =>
        stream(streamCall++ === 0 ? toolStep('call_1', 'y'.repeat(8000)) : textStep('done')),
      doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
        generateCalls.push(options.prompt as unknown as ModelMessage[]);
        return {
          content: [{ type: 'text', text: SUMMARY }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `u${i} ${'a'.repeat(2000)}` });
      history.push({ role: 'assistant', content: `a${i} ${'b'.repeat(2000)}` });
    }

    await runAgentLoop({
      model,
      messages: history,
      tools: { echo: echoTool },
      initialParts: [{ type: 'text', text: 'partial', state: 'done' }],
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      onCompactBeforeStep: async (request) => {
        requests.push(request);
        return null;
      },
    });

    // A resume prompt is a snapshot with no stored boundary to rebuild from.
    expect(requests).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
  });
});

describe('repeated durable folds', () => {
  it('replaces the previous projection instead of duplicating the live tail', async () => {
    const prompts: ModelMessage[][] = [];
    let streamCall = 0;
    const firstPayload = `first-payload-${'a'.repeat(8000)}`;

    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown as ModelMessage[]);
        return stream(
          streamCall++ === 0
            ? toolStep('call_1', firstPayload)
            : streamCall === 2
              ? toolStep('call_2', `second-payload-${'b'.repeat(8000)}`)
              : textStep('done'),
        );
      },
    });

    const requests: StepCompactionRequest[] = [];
    await runAgentLoop({
      model,
      messages: [
        { role: 'user', content: 'OLD-HISTORY' },
        { role: 'user', content: 'CURRENT-QUESTION' },
      ],
      tools: { echo: echoTool },
      compaction: {
        contextWindow: 3000,
        reserveTokens: 500,
        keepRecentTokens: 4000,
        summaryMessageCount: 0,
      },
      onCompactBeforeStep: async (request) => {
        requests.push(request);
        return {
          uiMessages: [
            {
              id: `summary-${requests.length}`,
              role: 'user',
              parts: [
                { type: 'text', text: `SUMMARY-${requests.length}`, state: 'done' },
              ],
            },
            {
              id: 'u-current',
              role: 'user',
              parts: [{ type: 'text', text: 'CURRENT-QUESTION', state: 'done' }],
            },
          ] as unknown as UIMessage[],
          priorSummary: `SUMMARY-${requests.length}`,
        };
      },
    });

    expect(requests).toHaveLength(2);
    expect(prompts).toHaveLength(3);

    // The second projection replaces the first; it does not stack.
    expect(JSON.stringify(prompts[1])).toContain('SUMMARY-1');
    const afterSecond = JSON.stringify(prompts[2]);
    expect(afterSecond).toContain('SUMMARY-2');
    expect(afterSecond).not.toContain('SUMMARY-1');
    // The live tail survives both rebuilds.
    expect(afterSecond).toContain('first-payload-');
    expect(afterSecond).toContain('second-payload');
  });
});


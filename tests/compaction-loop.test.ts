import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { tool } from 'ai';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { runAgentLoop } from '@/lib/ai';

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
    });

    expect(stoppedReason).toBe('finished');
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
});

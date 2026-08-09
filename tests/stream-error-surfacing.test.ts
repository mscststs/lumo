import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { runAgentLoop } from '@/lib/ai';
import { classifyError, isRetryableError } from '@/components/chat/ChatError';

const QUOTA_MESSAGE =
  '402 "You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers."';

/**
 * Providers are free to put arbitrary values on an `error` stream part — the
 * `error` field is typed `unknown`. `@ai-sdk/openai` enqueues a plain object
 * frame when a Responses stream ends with `response.failed` after generation has
 * started. This asserts the loop surfaces such a frame as a readable Error
 * rather than "[object Object]".
 */
function rawErrorFrame() {
  return {
    type: 'response.failed',
    sequence_number: 2,
    response: {
      error: { code: 'server_error', message: QUOTA_MESSAGE },
      incomplete_details: null,
    },
  };
}

function modelEmitting(parts: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: parts,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

describe('runAgentLoop error surfacing', () => {
  it('reports a non-Error provider frame as a readable message', async () => {
    const errors: unknown[] = [];

    await runAgentLoop({
      model: modelEmitting([
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'partial answer' },
        // The stream fails mid-generation, carrying a plain object.
        { type: 'error', error: rawErrorFrame() },
      ]),
      messages: [{ role: 'user', content: 'hi' }],
      onError: (error) => errors.push(error),
    });

    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error).toBeInstanceOf(Error);

    const message = (error as Error).message;
    // The regression: this used to be "[object Object]".
    expect(message).not.toContain('[object Object]');
    expect(message).toContain('depleted your monthly included credits');
  });

  it('keeps whatever was streamed before the failure', async () => {
    const { parts } = await runAgentLoop({
      model: modelEmitting([
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'partial answer' },
        { type: 'error', error: rawErrorFrame() },
      ]),
      messages: [{ role: 'user', content: 'hi' }],
      onError: () => {},
    });

    const text = parts
      .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('partial answer');
  });

  it('the surfaced error classifies as a non-retryable quota failure', async () => {
    const errors: Error[] = [];

    await runAgentLoop({
      model: modelEmitting([
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'x' },
        { type: 'error', error: rawErrorFrame() },
      ]),
      messages: [{ role: 'user', content: 'hi' }],
      onError: (error) => errors.push(error as Error),
    });

    const info = classifyError(errors[0] as Error);
    expect(info.category).toBe('quota');
    // Retrying a depleted account would burn the backoff and fail identically.
    expect(isRetryableError(info.category)).toBe(false);
  });
});

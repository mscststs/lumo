import { describe, it, expect } from 'vitest';
import {
  computeContextUsage,
  estimateDraftTokens,
  estimatePartsTokens,
  estimateTextTokens,
} from '@/lib/context-usage';
import type { ChatMessage, ChatMessagePart, TokenUsageStats } from '@/types';

/**
 * Context occupancy is a hybrid: a real provider count for everything up to the
 * last completed step, and a chars/4 heuristic after it. The fragile part is
 * *which* number is trusted. A turn's `usage.inputTokens` is the sum over every
 * tool step, so using it as the context size double-counts the whole history
 * once per step; the tests below pin the last-step rule precisely because that
 * mistake is invisible on a single-step turn and severe on a browsing one.
 */

function userMessage(text: string, id = 'u1'): ChatMessage {
  const parts: ChatMessagePart[] = [{ type: 'text', text, state: 'done' }];
  return { id, role: 'user', parts, timestamp: 0 };
}

function assistantMessage(usage: TokenUsageStats | undefined, id = 'a1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: 'ok', state: 'done' }],
    ...(usage ? { usage } : {}),
    timestamp: 0,
  };
}

/** A two-step turn whose summed input (1000) is far larger than its final prompt. */
const MULTI_STEP_USAGE: TokenUsageStats = {
  inputTokens: 1000,
  outputTokens: 200,
  totalTokens: 1200,
  steps: [
    { step: 0, inputTokens: 400, outputTokens: 50, totalTokens: 450 },
    { step: 1, inputTokens: 600, outputTokens: 150, totalTokens: 750 },
  ],
};

describe('computeContextUsage', () => {
  it('returns null when the model declares no window', () => {
    expect(computeContextUsage({ messages: [], model: {} })).toBeNull();
    expect(computeContextUsage({ messages: [], model: undefined })).toBeNull();
    expect(computeContextUsage({ messages: [], model: { contextWindow: 0 } })).toBeNull();
  });

  it('anchors on the last step, not the turn total', () => {
    const usage = computeContextUsage({
      messages: [userMessage('hi'), assistantMessage(MULTI_STEP_USAGE)],
      model: { contextWindow: 128_000 },
    })!;
    // 600 + 150, not 1000 + 200.
    expect(usage.tokens).toBe(750);
    expect(usage.inputTokens).toBe(600);
    expect(usage.outputTokens).toBe(150);
    expect(usage.estimated).toBe(false);
  });

  it('adds trailing messages to the anchored count', () => {
    const usage = computeContextUsage({
      messages: [
        userMessage('hi'),
        assistantMessage(MULTI_STEP_USAGE),
        userMessage('hello world', 'u2'),
      ],
      model: { contextWindow: 128_000 },
    })!;
    expect(usage.trailingTokens).toBe(estimateTextTokens('hello world'));
    expect(usage.tokens).toBe(750 + estimateTextTokens('hello world'));
  });

  it('falls back to a full estimate when no turn has completed', () => {
    const usage = computeContextUsage({
      messages: [userMessage('hello world')],
      systemPrompt: 'be helpful',
      model: { contextWindow: 128_000 },
    })!;
    expect(usage.estimated).toBe(true);
    expect(usage.tokens).toBe(
      estimateTextTokens('be helpful') + estimateTextTokens('hello world'),
    );
  });

  it('uses the active variant usage so the ring matches the visible reply', () => {
    const message = assistantMessage(MULTI_STEP_USAGE);
    message.variants = [
      {
        id: 'v0',
        parts: [{ type: 'text', text: 'older', state: 'done' }],
        timestamp: 0,
        usage: {
          inputTokens: 10_000,
          outputTokens: 20,
          totalTokens: 10_020,
          steps: [{ step: 0, inputTokens: 10_000, outputTokens: 20, totalTokens: 10_020 }],
        },
      },
    ];
    message.activeVariantIndex = 0;

    const usage = computeContextUsage({
      messages: [userMessage('hi'), message],
      model: { contextWindow: 128_000 },
    })!;
    expect(usage.tokens).toBe(10_020);
  });

  it('counts live streamed parts on top of the anchor', () => {
    const pendingParts: ChatMessagePart[] = [{ type: 'text', text: 'partial answer', state: 'streaming' }];
    const usage = computeContextUsage({
      messages: [userMessage('hi'), assistantMessage(MULTI_STEP_USAGE)],
      pendingParts,
      model: { contextWindow: 128_000 },
    })!;
    expect(usage.tokens).toBe(750 + estimatePartsTokens(pendingParts));
  });

  it('clamps the percentage at 100', () => {
    const usage = computeContextUsage({
      messages: [userMessage('x'.repeat(100_000))],
      model: { contextWindow: 1_000 },
    })!;
    expect(usage.percent).toBe(100);
  });

  it('treats an all-zero usage as no anchor', () => {
    const usage = computeContextUsage({
      messages: [
        userMessage('hello'),
        assistantMessage({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          steps: [{ step: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
        }),
      ],
      model: { contextWindow: 128_000 },
    })!;
    expect(usage.estimated).toBe(true);
  });
});

describe('estimateDraftTokens', () => {
  it('adds text, attachment bodies and a fixed cost per image', () => {
    const tokens = estimateDraftTokens({
      text: 'hello',
      images: ['data:image/png;base64,xxx'],
      attachments: [{ content: 'aaaa' }],
    });
    expect(tokens).toBe(Math.ceil(('hello'.length + 'aaaa'.length + 4800) / 4));
  });

  it('is zero for an empty draft', () => {
    expect(estimateDraftTokens({ text: '', images: [], attachments: [] })).toBe(0);
  });
});

describe('estimateTextTokens', () => {
  it('rounds up the chars/4 ratio', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });
});

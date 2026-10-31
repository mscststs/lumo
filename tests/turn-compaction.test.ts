import { describe, it, expect, vi } from 'vitest';
import { compactTurn, type SummarizeMessages } from '@/lib/turn-compaction';
import type { ChatMessage, CompactionSettings, Conversation } from '@/types';

/**
 * The three compaction triggers share this sequence. These tests pin the two
 * decisions that used to be duplicated at each call site: whether to run at all
 * (threshold vs forced) and what the summarizer is handed.
 */

const settings: CompactionSettings = {
  enabled: true,
  reserve: { unit: 'percent', value: 20 },
  keepRecentTokens: 1,
};

function message(id: string, role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text, state: 'done' }],
    timestamp: Number(id.replace(/\D/g, '')) || 0,
  };
}

function conversation(messages: ChatMessage[]): Conversation {
  return {
    id: 'c1',
    title: 't',
    messages,
    modelId: 'm',
    providerId: 'p',
    createdAt: 0,
    updatedAt: 0,
  };
}

const history = conversation([
  message('m1', 'user', 'first question'),
  message('m2', 'assistant', 'first answer'),
  message('m3', 'user', 'second question'),
  message('m4', 'assistant', 'second answer'),
]);

describe('compactTurn', () => {
  it('does nothing when the context is under the threshold', async () => {
    const summarize = vi.fn();
    const result = await compactTurn({
      conversation: history,
      model: { contextWindow: 1_000_000 },
      settings,
      summarize,
    });

    expect(result).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('folds history when forced, keeping the newest message', async () => {
    const summarize = vi.fn<SummarizeMessages>(async () => ({ text: 'SUMMARY' }));
    const result = await compactTurn({
      conversation: history,
      model: { contextWindow: 1_000_000 },
      settings,
      summarize,
      force: true,
    });

    expect(result).not.toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
    const summarized = summarize.mock.calls[0]![0];
    // The newest message is the cut point and stays verbatim.
    expect(summarized.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(result!.conversation.compaction?.firstKeptMessageId).toBe('m4');
    expect(result!.conversation.compaction?.summary).toBe('SUMMARY');
    expect(result!.tokensBefore).toBeGreaterThan(0);
  });

  it('folds automatically when the window is exceeded', async () => {
    const summarize = vi.fn<SummarizeMessages>(async () => ({ text: 'SUMMARY' }));
    const result = await compactTurn({
      conversation: history,
      model: { contextWindow: 10 },
      settings: { ...settings, reserve: { unit: 'percent', value: 10 } },
      summarize,
    });

    expect(result).not.toBeNull();
    expect(result!.conversation.compaction).toBeDefined();
  });

  it('reports nothing to do when the whole transcript fits the kept budget', async () => {
    const summarize = vi.fn();
    const result = await compactTurn({
      conversation: conversation([message('m1', 'user', 'only turn')]),
      model: { contextWindow: 1_000_000 },
      settings: { ...settings, keepRecentTokens: 100_000 },
      summarize,
      force: true,
    });

    expect(result).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('carries the previous checkpoint into a repeat compaction', async () => {
    const first = await compactTurn({
      conversation: history,
      model: { contextWindow: 1_000_000 },
      settings,
      summarize: async () => ({ text: 'FIRST' }),
      force: true,
    });

    const summarize = vi.fn<SummarizeMessages>(async () => ({ text: 'SECOND' }));
    const second = await compactTurn({
      conversation: {
        ...first!.conversation,
        messages: [
          ...first!.conversation.messages,
          message('m5', 'user', 'third question'),
          message('m6', 'assistant', 'third answer'),
        ],
      },
      model: { contextWindow: 1_000_000 },
      settings,
      summarize,
      force: true,
    });

    expect(second).not.toBeNull();
    const summarized = summarize.mock.calls[0]![0];
    expect(summarized.previousSummary).toBe('FIRST');
  });
});

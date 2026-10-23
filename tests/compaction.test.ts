import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COMPACTION_SETTINGS,
  RESERVE_PRESETS,
  applyCompaction,
  formatReserveAmount,
  normalizeCompactionSettings,
  parseReserveKey,
  planCompaction,
  projectConversation,
  reserveKey,
  resolveReserveTokens,
  serializeConversationForSummary,
  shouldCompact,
  COMPACTION_SUMMARY_PREFIX,
} from '@/lib/compaction';
import { computeContextUsage } from '@/lib/context-usage';
import type { ChatMessage, ChatMessagePart, Conversation } from '@/types';

let seq = 0;
function msg(role: 'user' | 'assistant', text: string, id?: string): ChatMessage {
  const n = seq++;
  return {
    id: id ?? `m${n}`,
    role,
    parts: [{ type: 'text', text, state: 'done' }],
    timestamp: 1000 + n,
  };
}

/** ~`tokens` tokens of text, via the chars/4 estimator. */
function longText(tokens: number): string {
  return 'x'.repeat(tokens * 4);
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

describe('normalizeCompactionSettings', () => {
  it('defaults a missing record to enabled with pi budgets', () => {
    expect(normalizeCompactionSettings(undefined)).toEqual(DEFAULT_COMPACTION_SETTINGS);
    expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);
  });

  it('honours an explicit false and keeps it as the only off switch', () => {
    expect(normalizeCompactionSettings({ enabled: false }).enabled).toBe(false);
    // Anything that is not an explicit `false` stays on.
    expect(normalizeCompactionSettings({ enabled: undefined as unknown as boolean }).enabled).toBe(
      true,
    );
  });

  it('replaces unusable budgets with the defaults', () => {
    const normalized = normalizeCompactionSettings({
      reserve: { unit: 'percent', value: 0 },
      keepRecentTokens: -5,
    });
    expect(normalized.reserve).toEqual(DEFAULT_COMPACTION_SETTINGS.reserve);
    expect(normalized.keepRecentTokens).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  });

  it('migrates the legacy absolute reserveTokens field', () => {
    const normalized = normalizeCompactionSettings({ reserveTokens: 32768 });
    expect(normalized.reserve).toEqual({ unit: 'tokens', value: 32768 });
  });

  it('defaults to a 20% window reserve', () => {
    expect(normalizeCompactionSettings(undefined).reserve).toEqual({ unit: 'percent', value: 20 });
  });

  it('keeps a valid percent reserve and rejects nonsensical ones', () => {
    expect(normalizeCompactionSettings({ reserve: { unit: 'percent', value: 15 } }).reserve).toEqual(
      { unit: 'percent', value: 15 },
    );
    // 0% would never trigger; above 90% would leave almost nothing sendable.
    expect(
      normalizeCompactionSettings({ reserve: { unit: 'percent', value: 0 } }).reserve,
    ).toEqual(DEFAULT_COMPACTION_SETTINGS.reserve);
    expect(
      normalizeCompactionSettings({ reserve: { unit: 'percent', value: 99 } }).reserve,
    ).toEqual(DEFAULT_COMPACTION_SETTINGS.reserve);
  });
});

describe('resolveReserveTokens', () => {
  it('resolves a percentage against the window', () => {
    expect(resolveReserveTokens({ unit: 'percent', value: 20 }, 128_000)).toBe(25_600);
  });

  it('treats an unsigned percentage as zero', () => {
    expect(resolveReserveTokens({ unit: 'percent', value: 20 }, 0)).toBe(0);
  });

  it('passes an absolute count through', () => {
    expect(resolveReserveTokens({ unit: 'tokens', value: 16384 }, 128_000)).toBe(16384);
  });
});

describe('reserve presets and formatting', () => {
  it('offers the curated list, defaulting to 20%', () => {
    expect(RESERVE_PRESETS.map(formatReserveAmount)).toEqual([
      '16K',
      '32K',
      '64K',
      '128K',
      '10%',
      '20%',
      '30%',
    ]);
    expect(DEFAULT_COMPACTION_SETTINGS.reserve).toEqual({ unit: 'percent', value: 20 });
  });

  it('round-trips every preset through its select key', () => {
    for (const preset of RESERVE_PRESETS) {
      expect(parseReserveKey(reserveKey(preset))).toEqual(preset);
    }
  });
});

describe('shouldCompact', () => {
  const settings = {
    enabled: true,
    reserve: { unit: 'tokens' as const, value: 1000 },
    keepRecentTokens: 500,
  };

  it('is false when disabled or the window is unknown', () => {
    expect(shouldCompact(99999, 10000, { ...settings, enabled: false })).toBe(false);
    expect(shouldCompact(99999, 0, settings)).toBe(false);
  });

  it('fires only once the reserved tail is crossed', () => {
    expect(shouldCompact(9000, 10000, settings)).toBe(false);
    expect(shouldCompact(9001, 10000, settings)).toBe(true);
  });

  it('scales the trigger with a percentage reserve', () => {
    const percent = { ...settings, reserve: { unit: 'percent' as const, value: 20 } };
    // 20% of 10000 is 2000 → triggers just past 8000.
    expect(shouldCompact(8000, 10000, percent)).toBe(false);
    expect(shouldCompact(8001, 10000, percent)).toBe(true);
  });
});

describe('planCompaction', () => {
  it('returns null when the transcript already fits the budget', () => {
    const conv = conversation([msg('user', longText(10)), msg('assistant', longText(10))]);
    expect(planCompaction(conv, 100)).toBeNull();
  });

  it('summarizes older messages and keeps the recent tail', () => {
    const messages = [
      msg('user', longText(100), 'a'),
      msg('assistant', longText(100), 'b'),
      msg('user', longText(100), 'c'),
      msg('assistant', longText(100), 'd'),
    ];
    const plan = planCompaction(conversation(messages), 150);
    expect(plan).not.toBeNull();
    // Walking back consumes `d` (100) then `c` (100 ≥ 150 budget after adding),
    // so the cut lands on `c`.
    expect(plan!.firstKeptMessageId).toBe('c');
    expect(plan!.messagesToSummarize.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('re-summarizes from the previous boundary and carries the prior summary', () => {
    const messages = [
      msg('user', longText(100), 'a'),
      msg('assistant', longText(100), 'b'),
      msg('user', longText(100), 'c'),
      msg('assistant', longText(100), 'd'),
      msg('user', longText(100), 'e'),
    ];
    const conv = applyCompaction(conversation(messages), {
      summary: 'OLD',
      firstKeptMessageId: 'c',
      tokensBefore: 500,
    });
    const plan = planCompaction(conv, 100);
    expect(plan).not.toBeNull();
    expect(plan!.previousSummary).toBe('OLD');
    // Only messages at/after the previous boundary are candidates.
    expect(plan!.messagesToSummarize[0]!.id).toBe('c');
  });
});

describe('applyCompaction', () => {
  it('anchors the transcript seam to the newest message by default', () => {
    const messages = [msg('user', 'a', 'a'), msg('assistant', 'b', 'b')];
    const conv = applyCompaction(conversation(messages), {
      summary: 'S',
      firstKeptMessageId: 'a',
      tokensBefore: 1,
    });
    expect(conv.compaction!.firstKeptMessageId).toBe('a');
    expect(conv.compaction!.triggeredAtMessageId).toBe('b');
  });
});

describe('projectConversation', () => {
  it('returns the full transcript when there is no checkpoint', () => {
    const conv = conversation([msg('user', 'hi')]);
    expect(projectConversation(conv)).toBe(conv.messages);
  });

  it('prepends the checkpoint and drops the summarized range', () => {
    const messages = [
      msg('user', 'old question', 'a'),
      msg('assistant', 'old answer', 'b'),
      msg('user', 'new question', 'c'),
    ];
    const conv = applyCompaction(conversation(messages), {
      summary: 'SUMMARY',
      firstKeptMessageId: 'c',
      tokensBefore: 500,
    });
    const projected = projectConversation(conv);
    expect(projected).toHaveLength(2);
    expect(projected[1]!.id).toBe('c');
    const summaryText = projected[0]!.parts?.[0];
    expect(summaryText).toMatchObject({ type: 'text' });
    expect((summaryText as { text: string }).text).toBe(
      `${COMPACTION_SUMMARY_PREFIX}SUMMARY\n</summary>`,
    );
  });

  it('falls back to the full transcript when the boundary is gone', () => {
    const conv = applyCompaction(conversation([msg('user', 'hi', 'a')]), {
      summary: 'S',
      firstKeptMessageId: 'deleted',
      tokensBefore: 1,
    });
    expect(projectConversation(conv)).toBe(conv.messages);
  });
});

describe('serializeConversationForSummary', () => {
  it('labels roles and renders tool calls and results', () => {
    const messages: ChatMessage[] = [
      msg('user', 'open the page'),
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        parts: [
          { type: 'text', text: 'Sure', state: 'done' },
          {
            type: 'tool-navigate',
            toolCallId: 'tc1',
            state: 'output-available',
            input: { url: 'https://example.com' },
            output: { content: [{ type: 'text', text: 'loaded' }], isError: false },
          } as unknown as ChatMessagePart,
        ],
      },
    ];
    const text = serializeConversationForSummary(messages);
    expect(text).toContain('[User]: open the page');
    expect(text).toContain('[Assistant]: Sure');
    expect(text).toContain('[Assistant tool calls]: navigate(');
    expect(text).toContain('[Tool result]:');
    expect(text).toContain('https://example.com');
  });
});

describe('computeContextUsage with a checkpoint', () => {
  const model = { contextWindow: 100000 };

  it('ignores usage recorded before the checkpoint and counts the summary', () => {
    const old = msg('assistant', 'old answer', 'b');
    old.usage = {
      inputTokens: 5000,
      outputTokens: 100,
      totalTokens: 5100,
      steps: [{ step: 0, inputTokens: 5000, outputTokens: 100, totalTokens: 5100 }],
    };
    const kept = msg('user', 'new question', 'c');
    const conv = applyCompaction(conversation([msg('user', longText(5000), 'a'), old, kept]), {
      summary: 'SUMMARY',
      firstKeptMessageId: 'c',
      tokensBefore: 5100,
    });

    const usage = computeContextUsage({
      messages: conv.messages,
      model,
      compaction: {
        createdAt: conv.compaction!.createdAt,
        summary: conv.compaction!.summary,
        firstKeptMessageId: conv.compaction!.firstKeptMessageId,
      },
    })!;

    // The pre-checkpoint anchor is unusable, so the whole context is estimated
    // rather than inheriting the stale 5100-token count.
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBe(0);
    // Summary + kept message only, not the summary + every stored message.
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.tokens).toBeLessThan(100);
  });
});

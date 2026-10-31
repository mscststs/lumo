// @vitest-environment jsdom
/**
 * Durable between-step compaction: the store folds the stored transcript,
 * writes the checkpoint together with the partial turn, and hands the loop a
 * fresh projection — never re-summarizing the live tail.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChatMessagePart, Conversation, ProviderConfig, ModelConfig } from '@/types';
import type { StepCompactionResult } from '@/lib/ai';

const provider: ProviderConfig = {
  id: 'p1',
  name: 'P',
  type: 'openai-chat',
  baseUrl: 'https://x/v1',
  apiKey: 'k',
  models: [
    {
      id: 'm1',
      modelId: 'gpt-x',
      displayName: 'M',
      isVision: false,
      // Large enough that the pre-send threshold never fires.
      contextWindow: 1_000_000,
    },
  ],
};
const model: ModelConfig = provider.models[0]!;

const SUMMARY = 'DURABLE-SUMMARY-OF-OLDER-TURNS';

let capturedResult: StepCompactionResult | null = null;
let draftAtCompaction: Conversation | null = null;
let sendCount = 0;

const generateSpy = vi.fn(async (_opts: unknown) => ({ text: SUMMARY }));

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: (opts: unknown) => generateSpy(opts),
  chatStream: async (opts: {
    conversationId: string;
    onUpdate: (parts: ChatMessagePart[]) => void;
    onFinish: (parts: ChatMessagePart[], reason: string) => void;
    onCompactBeforeStep?: (request: { step: number; tokensBefore: number }) => Promise<StepCompactionResult | null>;
  }) => {
    sendCount += 1;
    if (sendCount === 1) {
      opts.onFinish([{ type: 'text', text: 'first reply', state: 'done' }], 'finished');
      return;
    }

    // A completed step produced something before the next request needs room.
    opts.onUpdate([{ type: 'text', text: 'partial live reply', state: 'streaming' }]);
    capturedResult = (await opts.onCompactBeforeStep?.({ step: 0, tokensBefore: 999 })) ?? null;

    // Read the record before the turn settles: the checkpoint must already be
    // durable, not only written by the final save.
    const { getConversation } = await import('@/lib/conversation-store');
    draftAtCompaction = await getConversation(opts.conversationId);

    opts.onFinish([{ type: 'text', text: 'second reply', state: 'done' }], 'finished');
  },
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));
vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    getUISettings: async () => ({
      maxSteps: 0,
      compaction: {
        enabled: true,
        reserve: { unit: 'tokens', value: 100 },
        keepRecentTokens: 1,
      },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

const { useChatStream } = await import('@/store/useChatStream');

beforeEach(() => {
  capturedResult = null;
  draftAtCompaction = null;
  sendCount = 0;
  generateSpy.mockClear();
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => {
          Object.assign(store, o);
        },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
});

async function send(hook: { current: ReturnType<typeof useChatStream> }, text: string) {
  await act(async () => {
    await hook.current.handleSend(text, [], [], () => provider, () => model, 'p1', 'm1');
    await new Promise((r) => setTimeout(r, 40));
  });
}

describe('durable between-step compaction', () => {
  it('persists the checkpoint with the partial turn and returns the projection', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await send(result, 'first question');
    await send(result, 'second question');

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(capturedResult).not.toBeNull();

    // The checkpoint is already on disk while the turn is still streaming.
    expect(draftAtCompaction?.compaction?.summary).toBe(SUMMARY);
    expect(
      draftAtCompaction?.messages.some((m) =>
        m.parts?.some((p) => p.type === 'text' && p.text === 'partial live reply'),
      ),
    ).toBe(true);

    // The projection starts with the checkpoint and keeps the current question.
    const uiMessages = capturedResult!.uiMessages;
    expect(uiMessages).toHaveLength(2);
    expect(JSON.stringify(uiMessages[0])).toContain(SUMMARY);
    expect(JSON.stringify(uiMessages[1])).toContain('second question');
    expect(capturedResult!.priorSummary).toBe(SUMMARY);

    // The settled conversation keeps every message and gains the checkpoint.
    const final = result.current.currentConversation!;
    expect(final.compaction?.summary).toBe(SUMMARY);
    expect(final.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

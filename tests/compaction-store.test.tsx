// @vitest-environment jsdom
/**
 * Integration coverage for the durable (pre-send) compaction path: a long
 * conversation must be summarized before the next request, and the request the
 * model actually receives must be the *projection* — checkpoint plus kept
 * messages — while the stored transcript keeps every message.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChatMessagePart, ProviderConfig, ModelConfig } from '@/types';

const provider: ProviderConfig = {
  id: 'p1',
  name: 'P',
  type: 'openai-chat',
  baseUrl: 'https://x/v1',
  apiKey: 'k',
  models: [
    { id: 'm1', modelId: 'gpt-x', displayName: 'M', isVision: false, contextWindow: 500 },
  ],
};
const model: ModelConfig = provider.models[0]!;

interface CapturedMessage {
  parts?: Array<{ type?: string; text?: string }>;
}

const capturedPerSend: CapturedMessage[][] = [];
const generateSpy = vi.fn(async (_opts: unknown) => ({ text: 'SUMMARY-OF-EARLIER-HISTORY' }));

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: (opts: unknown) => generateSpy(opts),
  chatStream: async (opts: {
    messages: CapturedMessage[];
    onFinish: (p: ChatMessagePart[], r: string) => void;
  }) => {
    capturedPerSend.push(opts.messages);
    opts.onFinish([{ type: 'text', text: 'reply', state: 'done' }] as ChatMessagePart[], 'finished');
  },
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));
vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    // Tiny budgets so the second message always crosses the threshold.
    getUISettings: async () => ({
      maxSteps: 0,
      compaction: { enabled: true, reserve: { unit: 'tokens', value: 100 }, keepRecentTokens: 1 },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

const { useChatStream } = await import('@/store/useChatStream');

beforeEach(() => {
  capturedPerSend.length = 0;
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
    // Let the persistence writes commit.
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe('pre-send compaction', () => {
  it('summarizes older turns and sends the projected prompt', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    // First turn: only one user message exists, so there is nothing to fold.
    await send(result, 'first question '.repeat(200));
    expect(generateSpy).not.toHaveBeenCalled();
    expect(capturedPerSend).toHaveLength(1);

    // Second turn: the previous turn is now summarizable.
    await send(result, 'second question');
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // The summarizer saw the older messages, not the new question.
    const summarizeArgs = generateSpy.mock.calls[0]![0] as {
      messages: Array<{ id: string }>;
      previousSummary?: string;
    };
    expect(summarizeArgs.messages).toHaveLength(2);
    expect(summarizeArgs.previousSummary).toBeUndefined();

    // The model's prompt is the projection: checkpoint first, then the new
    // user message only.
    const secondPrompt = capturedPerSend[1]!;
    expect(secondPrompt).toHaveLength(2);
    const summaryText = secondPrompt[0]!.parts?.[0]?.text ?? '';
    expect(summaryText).toContain('SUMMARY-OF-EARLIER-HISTORY');
    expect(secondPrompt[1]!.parts?.some((p) => p.text === 'second question')).toBe(true);

    // ...and the stored conversation still holds every message plus the
    // checkpoint, so nothing was destructively truncated.
    const conv = result.current.currentConversation;
    expect(conv?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv?.compaction?.summary).toBe('SUMMARY-OF-EARLIER-HISTORY');
  });
});

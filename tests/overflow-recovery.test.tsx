// @vitest-environment jsdom
/**
 * Context-overflow recovery: when the provider rejects a prompt as too long,
 * the store folds history once and retries instead of resending the same
 * oversized request on the generic backoff path.
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
    {
      id: 'm1',
      modelId: 'gpt-x',
      displayName: 'M',
      isVision: false,
      // Large enough that the pre-send threshold never fires; recovery is what
      // this test is about.
      contextWindow: 1_000_000,
    },
  ],
};
const model: ModelConfig = provider.models[0]!;

interface CapturedSend {
  messages: Array<{ parts?: Array<{ type?: string; text?: string }> }>;
}

const captured: CapturedSend[] = [];
/** Zero-based call indices that should fail with a context overflow. */
const overflowCalls = new Set<number>();
let callIndex = 0;

const generateSpy = vi.fn(async (_opts: unknown) => ({ text: 'SUMMARY-OF-EARLIER-HISTORY' }));

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: (opts: unknown) => generateSpy(opts),
  chatStream: async (opts: {
    messages: CapturedSend['messages'];
    onError: (error: Error) => void;
    onFinish: (parts: ChatMessagePart[], reason: string) => void;
  }) => {
    captured.push({ messages: opts.messages });
    if (overflowCalls.has(callIndex++)) {
      opts.onError(new Error('context_length_exceeded: prompt is too long'));
      return;
    }
    opts.onFinish([{ type: 'text', text: 'reply', state: 'done' }] as ChatMessagePart[], 'finished');
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
  captured.length = 0;
  overflowCalls.clear();
  callIndex = 0;
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
    // Let the summarizer, the save and the recovered stream settle.
    await new Promise((r) => setTimeout(r, 80));
  });
}

describe('context-overflow recovery', () => {
  it('folds history once and retries with the compacted prompt', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await send(result, 'first question');
    expect(captured).toHaveLength(1);

    // The second turn's first request overflows; the retry must succeed.
    overflowCalls.add(1);
    await send(result, 'second question');

    expect(captured).toHaveLength(3);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // The failed request carried the full projection; the retry carries the
    // checkpoint plus the newest message only.
    expect(captured[1]!.messages.length).toBe(3);
    const retried = captured[2]!.messages;
    expect(retried).toHaveLength(2);
    expect(retried[0]!.parts?.[0]?.text).toContain('SUMMARY-OF-EARLIER-HISTORY');
    expect(retried[1]!.parts?.some((p) => p.text === 'second question')).toBe(true);

    expect(result.current.chatError).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentConversation?.compaction?.summary).toBe(
      'SUMMARY-OF-EARLIER-HISTORY',
    );
  });

  it('surfaces the overflow instead of retrying it a second time', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await send(result, 'first question');

    // Both the original request and the recovered one overflow.
    overflowCalls.add(1);
    overflowCalls.add(2);
    await send(result, 'second question');

    // One fold attempt, then the error surfaces; no third send.
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(3);
    expect(result.current.chatError?.message).toContain('context_length_exceeded');
    expect(result.current.isStreaming).toBe(false);
  });
});

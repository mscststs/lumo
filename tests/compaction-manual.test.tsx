// @vitest-environment jsdom
/**
 * `/compact` must use exactly the same cut rule as the automatic path.
 *
 * Regression: an earlier version gave the manual command its own
 * "keep only the last turn" policy, which produced a checkpoint seam pinned to
 * the bottom of the transcript and ignored the configured budget. Manual
 * compaction now calls `planCompaction` with `keepRecentTokens`, like pi.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChatMessagePart, ProviderConfig, ModelConfig } from '@/types';

// A window large enough that the automatic threshold is never crossed, so any
// checkpoint that appears must come from the manual command.
const provider: ProviderConfig = {
  id: 'p1',
  name: 'P',
  type: 'openai-chat',
  baseUrl: 'https://x/v1',
  apiKey: 'k',
  models: [
    { id: 'm1', modelId: 'gpt-x', displayName: 'M', isVision: false, contextWindow: 1_000_000 },
  ],
};
const model: ModelConfig = provider.models[0]!;

// Mutable so each test can choose the budget the manual command reads.
const state = vi.hoisted(() => ({
  reserve: { unit: 'tokens' as const, value: 16384 },
  keepRecentTokens: 20000,
}));

const generateSpy = vi.fn(async (_opts: unknown) => ({ text: 'MANUAL-SUMMARY' }));

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: (opts: unknown) => generateSpy(opts),
  chatStream: async (opts: {
    onFinish: (p: ChatMessagePart[], r: string) => void;
  }) => {
    opts.onFinish([{ type: 'text', text: 'reply', state: 'done' }] as ChatMessagePart[], 'finished');
  },
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));
vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    getUISettings: async () => ({
      maxSteps: 0,
      compaction: { enabled: true, ...state },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

const { useChatStream } = await import('@/store/useChatStream');

beforeEach(() => {
  generateSpy.mockClear();
  state.keepRecentTokens = 20000;
  state.reserve = { unit: 'tokens', value: 16384 };
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
    await new Promise((r) => setTimeout(r, 30));
  });
}

async function compact(hook: { current: ReturnType<typeof useChatStream> }) {
  await act(async () => {
    hook.current.handleCompact(() => provider, () => model);
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe('/compact', () => {
  it('compacts using keepRecentTokens, the same rule as the automatic path', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));
    await send(result, 'first question '.repeat(20));
    await send(result, 'second question '.repeat(20));

    // Budget smaller than the last turn, so the cut lands on the last user
    // message and everything older is summarized.
    state.keepRecentTokens = 10;

    const messagesBefore = result.current.currentConversation!.messages;
    const lastUserId = messagesBefore[messagesBefore.length - 2]!.id;
    const lastMessageId = messagesBefore[messagesBefore.length - 1]!.id;

    await compact(result);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const conv = result.current.currentConversation;
    expect(conv?.compaction?.summary).toBe('MANUAL-SUMMARY');
    expect(conv?.compaction?.firstKeptMessageId).toBe(lastUserId);
    // The seam is anchored to the newest message at the trigger moment, not to
    // the prompt-projection boundary.
    expect(conv?.compaction?.triggeredAtMessageId).toBe(lastMessageId);
    // The stored transcript is untouched.
    expect(conv?.messages).toHaveLength(4);
  });

  it('is a no-op when the conversation already fits keepRecentTokens', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));
    await send(result, 'first question');
    await send(result, 'second question');

    // Default budget (20k) dwarfs this conversation: nothing to compact.
    await compact(result);

    expect(generateSpy).not.toHaveBeenCalled();
    expect(result.current.currentConversation?.compaction).toBeUndefined();
    // Instead of vanishing, it explains why.
    expect(result.current.compactionNotice).toEqual({
      kind: 'nothing-to-compact',
      keepRecentTokens: 20000,
    });
  });
});

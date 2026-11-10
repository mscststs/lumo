// @vitest-environment jsdom
/**
 * The retry card must retract when the retried request succeeds.
 *
 * An automatic retry puts a failure card under the reply ("Retrying 1/3" plus
 * the provider text). If that state survived the retry itself, the card stayed
 * pinned below a reply that was visibly streaming fine, and only went away when
 * the whole turn settled — minutes later on a long tool loop, or never from the
 * user's point of view. Recovery is therefore tied to the retried request
 * producing output, not to the turn ending.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChatMessagePart, ModelConfig, ProviderConfig } from '@/types';

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
      contextWindow: 1_000_000,
    },
  ],
};
const model: ModelConfig = provider.models[0]!;

interface StreamOptions {
  onUpdate: (parts: ChatMessagePart[]) => void;
  onFinish: (parts: ChatMessagePart[], reason: string) => void;
  onError: (error: Error) => void;
}

/** Held until the test wants the recovered request to emit its first part. */
let releaseFirstPart: () => void = () => {};
let firstPartGate = Promise.resolve();
/** Held until the test wants the recovered request to finish. */
let releaseFinish: () => void = () => {};
let finishGate = Promise.resolve();

let callIndex = 0;

const defaultChatStream = async (opts: StreamOptions) => {
  const call = callIndex++;
  // The recovered request is call #2: it must stay silent until released, so
  // the intermediate "retrying" state can be observed deterministically.
  if (call === 2) {
    await firstPartGate;
    opts.onUpdate([{ type: 'text', text: 'recovered reply', state: 'streaming' }]);
    await finishGate;
    opts.onFinish([{ type: 'text', text: 'recovered reply', state: 'done' }], 'finished');
    return;
  }
  if (call === 1) {
    opts.onError(new Error('502 Bad Gateway'));
    return;
  }
  opts.onFinish([{ type: 'text', text: 'first reply', state: 'done' }], 'finished');
};

const chatStream = vi.fn(defaultChatStream);

// The real backoff is 1.5s, 3s, 6s — irrelevant to what this suite pins.
vi.mock('@/lib/retry-policy', () => ({
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY: 1,
  retryDelay: () => 1,
}));

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: async () => ({ text: 'SUMMARY' }),
  chatStream: (opts: StreamOptions) => chatStream(opts),
}));

vi.mock('@/lib/turn-prompt', () => ({
  buildTurnSystemPrompt: async () => undefined,
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    getUISettings: async () => ({
      maxSteps: 0,
      compaction: {
        enabled: false,
        reserve: { unit: 'tokens', value: 100 },
        keepRecentTokens: 1,
      },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

const { useChatStream } = await import('@/store/useChatStream');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  callIndex = 0;
  chatStream.mockReset();
  chatStream.mockImplementation(defaultChatStream);
  firstPartGate = new Promise<void>((resolve) => {
    releaseFirstPart = resolve;
  });
  finishGate = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => {
          Object.assign(store, o);
        },
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
});

const send = (
  handleSend: ReturnType<typeof useChatStream>['handleSend'],
  text: string,
): Promise<void> => handleSend(text, [], [], () => provider, () => model, 'p1', 'm1');

describe('retry card', () => {
  it('retracts once the retried request produces output', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      await send(result.current.handleSend, 'first question');
      await sleep(60);
    });
    expect(result.current.chatError).toBeNull();

    // The second turn's request fails with a retryable 502.
    await act(async () => {
      void send(result.current.handleSend, 'second question');
      // First turn, the failed attempt, then the retry that is now in flight.
      await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(3), { timeout: 5000 });
    });

    // The retry was announced, and the turn is still streaming behind the card.
    expect(result.current.chatError?.message).toContain('502');
    expect(result.current.isRetrying).toBe(true);
    expect(result.current.isStreaming).toBe(true);

    // The retried request came back with its first part: the failure it
    // replaced must be gone while the reply keeps streaming.
    await act(async () => {
      releaseFirstPart();
      await sleep(60);
    });
    expect(result.current.chatError).toBeNull();
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      releaseFinish();
      await sleep(80);
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.chatError).toBeNull();
  }, 20_000);

  it('keeps the card when the retry fails again', async () => {
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      await send(result.current.handleSend, 'first question');
      await sleep(60);
    });

    // Every subsequent attempt fails with the same retryable 502.
    chatStream.mockImplementation(async (opts: StreamOptions) => {
      opts.onError(new Error('502 Bad Gateway'));
    });

    await act(async () => {
      void send(result.current.handleSend, 'second question');
      // The first turn, then the original attempt plus three retries; after
      // that the failure is final and the card stays.
      await waitFor(() => expect(chatStream.mock.calls.length).toBe(5), { timeout: 5000 });
      await sleep(120);
    });

    expect(result.current.chatError?.message).toContain('502');
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.retryAttempt).toBe(3);
  }, 20_000);
});

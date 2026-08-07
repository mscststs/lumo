// @vitest-environment jsdom
/**
 * The regression this file exists for: an assistant reply that was still
 * streaming when the panel went away used to be lost completely.
 *
 * `chatStream`'s `onFinish` was the only place a turn was ever persisted, and
 * closing the side panel tears the document down before it runs. The user
 * message had already been saved, so reopening the conversation showed a
 * question with no answer and no hint that anything had been dropped.
 *
 * These drive the real `useChatStream` against a scripted stream, and assert on
 * what reaches the conversation store.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChatMessagePart, ProviderConfig, ModelConfig } from '@/types';

const provider: ProviderConfig = {
  id: 'p1', name: 'P', type: 'openai-chat',
  baseUrl: 'https://x/v1', apiKey: 'k',
  models: [{ id: 'm1', modelId: 'gpt-x', displayName: 'M', isVision: false }],
};
const model: ModelConfig = provider.models[0]!;

/** Hands the test control over the in-flight stream. */
interface StreamControl {
  emit: (parts: ChatMessagePart[]) => void;
  finish: (parts: ChatMessagePart[]) => void;
  signal: AbortSignal;
}
let active: StreamControl | null = null;

// The stream is stubbed rather than the provider: this suite is about what the
// hook persists, and a real model round-trip would only add nondeterminism.
vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  chatStream: async (opts: {
    signal?: AbortSignal;
    onUpdate: (p: ChatMessagePart[]) => void;
    onFinish: (p: ChatMessagePart[]) => void;
  }) => {
    let settle: () => void;
    const done = new Promise<void>((r) => { settle = r; });
    active = {
      signal: opts.signal!,
      emit: (parts) => opts.onUpdate(parts),
      finish: (parts) => { opts.onFinish(parts); settle(); },
    };
    // Mirrors the real abort path in `lib/ai.ts`, which routes whatever was
    // streamed into `onFinish` instead of `onError`.
    opts.signal?.addEventListener('abort', () => {
      if (active) active.finish(lastEmitted);
    });
    await done;
  },
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));
vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    bumpConversationsRevision: async () => {},
  },
}));

let lastEmitted: ChatMessagePart[] = [];

const { useChatStream } = await import('@/store/useChatStream');
const { getConversation, listConversationMeta } = await import('@/lib/conversation-store');

function text(t: string, state: 'streaming' | 'done' = 'streaming'): ChatMessagePart[] {
  return [{ type: 'text', text: t, state }] as ChatMessagePart[];
}

beforeEach(() => {
  active = null;
  lastEmitted = [];
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
});

/** Sends a message and streams `chunk` into the reply, without settling it. */
async function startStreamingReply(hook: { current: ReturnType<typeof useChatStream> }, chunk: string) {
  await act(async () => {
    void hook.current.handleSend('hi', [], [], () => provider, () => model, 'p1', 'm1');
    // `handleSend` awaits the user-turn write (a real IndexedDB transaction)
    // before it reaches `chatStream`, so poll rather than assuming a fixed
    // number of microtasks.
    for (let i = 0; i < 200 && !active; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  });
  expect(active, 'the stream should have started').not.toBeNull();
  await act(async () => {
    lastEmitted = text(chunk);
    active!.emit(lastEmitted);
    await Promise.resolve();
  });
}

/** Lets pending IndexedDB writes commit. */
async function settleWrites() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function storedConversation() {
  const [meta] = await listConversationMeta();
  expect(meta, 'expected a conversation to have been stored').toBeDefined();
  return (await getConversation(meta!.id))!;
}

describe('interrupted reply persistence', () => {
  it('keeps a partial reply when the panel is hidden mid-stream', async () => {
    const hook = renderHook(() => useChatStream());
    await startStreamingReply(hook.result, 'half an answ');

    // Closing the side panel hides the document before it is torn down.
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden', configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settleWrites();

    const conv = await storedConversation();
    // The whole point: the reply is on disk, not just the question.
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1]!.role).toBe('assistant');
    expect((conv.messages[1]!.parts![0] as { text: string }).text).toBe('half an answ');
    // ...and it is marked, so a truncated answer cannot pass for a complete one.
    expect(conv.messages[1]!.interrupted).toBe(true);
  });

  it('keeps a partial reply when the panel unmounts mid-stream', async () => {
    const hook = renderHook(() => useChatStream());
    await startStreamingReply(hook.result, 'partial');

    // A split panel being closed, or collapsed by a width change.
    await act(async () => {
      hook.unmount();
    });
    await settleWrites();

    const conv = await storedConversation();
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1]!.interrupted).toBe(true);
  });

  it('aborts the request on unmount so it cannot keep running', async () => {
    const hook = renderHook(() => useChatStream());
    await startStreamingReply(hook.result, 'partial');
    const signal = active!.signal;

    expect(signal.aborted).toBe(false);
    await act(async () => { hook.unmount(); });
    expect(signal.aborted).toBe(true);
  });

  it('marks a reply the user stopped as interrupted', async () => {
    const hook = renderHook(() => useChatStream());
    await startStreamingReply(hook.result, 'stopped here');

    await act(async () => {
      hook.result.current.handleStop();
    });
    await settleWrites();

    const conv = await storedConversation();
    expect(conv.messages[1]!.interrupted).toBe(true);
    expect((conv.messages[1]!.parts![0] as { text: string }).text).toBe('stopped here');
  });

  it('does not mark a reply that finished on its own', async () => {
    const hook = renderHook(() => useChatStream());
    await startStreamingReply(hook.result, 'complete');

    await act(async () => {
      active!.finish(text('complete answer', 'done'));
    });
    await settleWrites();

    const conv = await storedConversation();
    expect(conv.messages[1]!.interrupted).toBeUndefined();
    expect((conv.messages[1]!.parts![0] as { text: string }).text).toBe('complete answer');
  });

  it('replaces the checkpoint rather than appending a second reply', async () => {
    // A checkpoint and the final save target the same message id, so a turn that
    // streams, checkpoints, then completes must leave exactly one reply.
    const hook = renderHook(() => useChatStream());
    await startStreamingReply(hook.result, 'first');

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden', configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settleWrites();

    await act(async () => {
      active!.finish(text('first and second', 'done'));
    });
    await settleWrites();

    const conv = await storedConversation();
    expect(conv.messages).toHaveLength(2);
    expect((conv.messages[1]!.parts![0] as { text: string }).text).toBe('first and second');
  });
});

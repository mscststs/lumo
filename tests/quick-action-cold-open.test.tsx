// @vitest-environment jsdom
/**
 * Cold-open regression: a quick action fired while the side panel was closed
 * must still run once the panel finishes loading its model selection.
 *
 * The panel mounts and the action is dispatched while the async read of
 * providers from `chrome.storage` is still in flight. Acting on it at that point
 * hits `handleSend`'s `if (!provider || !model) return` guard and drops it
 * silently — the bug where picking "Translate this page" with the panel closed
 * only opened the panel.
 *
 * The real `useModelSelection` is used deliberately, against a deliberately slow
 * storage stub: mocking it away would mock away the very race under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import type { ChatPanelHandle } from '@/components/chat/ChatPanel';
import type { ContextMenuPendingData } from '@/lib/context-menu';

/** How long the stubbed `chrome.storage` takes to answer. */
const STORAGE_DELAY_MS = 30;

const PROVIDERS = [
  {
    id: 'p1',
    name: 'P',
    apiKey: 'k',
    baseUrl: 'https://x',
    models: [{ id: 'm1', modelId: 'm1', displayName: 'M1', isVision: true }],
  },
];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Providers resolve slowly, reproducing cold-start latency.
vi.mock('@/store/storage', () => ({
  storage: {
    getProviders: async () => {
      await new Promise((r) => setTimeout(r, STORAGE_DELAY_MS));
      return PROVIDERS;
    },
    getUISettings: async () => ({ language: 'en', theme: 'light', maxSplitPanels: 1, sendKey: 'enter' }),
    getCommandSettings: async () => ({ enabled: true, userCommands: [], disabledBuiltins: [] }),
  },
}));

const handleSend = vi.fn();

vi.mock('@/store/useChatStream', () => ({
  useChatStream: () => ({
    conversations: [],
    currentConversation: null,
    isHistoryOpen: false,
    setIsHistoryOpen: vi.fn(),
    isStreaming: false,
    streamingMessage: null,
    chatError: null,
    isRetrying: false,
    retryAttempt: 0,
    handleSend,
    handleRetry: vi.fn(),
    handleStop: vi.fn(),
    handleNewChat: vi.fn(),
    handleSelectConversation: vi.fn(),
    handleDeleteConversation: vi.fn(),
    handleClearAllConversations: vi.fn(),
  }),
}));

// The chat surface is irrelevant here; only the send path is under test.
vi.mock('@/components/chat/ChatHeader', () => ({ ChatHeader: () => null }));
vi.mock('@/components/chat/ChatMessageList', () => ({ ChatMessageList: () => null }));
vi.mock('@/components/chat/ConversationFiles', () => ({ ConversationFiles: () => null }));
vi.mock('@/components/chat/ConversationHistory', () => ({ ConversationHistory: () => null }));

function pending(overrides: Partial<ContextMenuPendingData> = {}): ContextMenuPendingData {
  return {
    actionId: 'lumo-page-translate',
    type: 'page',
    pageContext: { tabId: 7, title: 'Example', url: 'https://example.com' },
    prompt: 'translate this',
    autoSend: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  handleSend.mockClear();
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async () => {
          await new Promise((r) => setTimeout(r, STORAGE_DELAY_MS));
          return {};
        },
        set: async () => {},
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { openOptionsPage: vi.fn() },
  };
});

describe('ChatPanel quick action on cold open', () => {
  it('sends once the model finishes loading, not silently dropping it', async () => {
    const { ChatPanel } = await import('@/components/chat/ChatPanel');
    const ref = createRef<ChatPanelHandle>();

    render(
      <ChatPanel
        ref={ref}
        panelIndex={0}
        showSettings
        showSplitButton={false}
        showClose={false}
        occupiedSessionIds={[]}
      />,
    );

    // Dispatch while providers are still in flight — the cold-open timing.
    act(() => {
      ref.current!.applyQuickAction(pending(), 'send');
    });
    expect(handleSend, 'must not send before a model is known').not.toHaveBeenCalled();

    // Let the provider read resolve; the parked action should replay.
    await act(async () => {
      await new Promise((r) => setTimeout(r, STORAGE_DELAY_MS * 4));
    });

    expect(handleSend).toHaveBeenCalledTimes(1);
    const [input, images, attachments] = handleSend.mock.calls[0]!;
    expect(input).toBe('translate this');
    expect(images).toEqual([]);
    // The page context must ride along so the model knows which tab it is on.
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe('page-context');
    expect(attachments[0].content).toContain('tabId: 7');
  });

  it('replays only the most recent action when several arrive before load', async () => {
    const { ChatPanel } = await import('@/components/chat/ChatPanel');
    const ref = createRef<ChatPanelHandle>();

    render(
      <ChatPanel
        ref={ref}
        panelIndex={0}
        showSettings
        showSplitButton={false}
        showClose={false}
        occupiedSessionIds={[]}
      />,
    );

    act(() => {
      ref.current!.applyQuickAction(pending({ prompt: 'first' }), 'send');
      ref.current!.applyQuickAction(pending({ prompt: 'second' }), 'send');
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, STORAGE_DELAY_MS * 4));
    });

    expect(handleSend).toHaveBeenCalledTimes(1);
    expect(handleSend.mock.calls[0]![0]).toBe('second');
  });

  it('still sends when the panel was already warm', async () => {
    const { ChatPanel } = await import('@/components/chat/ChatPanel');
    const ref = createRef<ChatPanelHandle>();

    render(
      <ChatPanel
        ref={ref}
        panelIndex={0}
        showSettings
        showSplitButton={false}
        showClose={false}
        occupiedSessionIds={[]}
      />,
    );

    // Wait for load first, then dispatch — the already-open-panel path.
    await act(async () => {
      await new Promise((r) => setTimeout(r, STORAGE_DELAY_MS * 4));
    });

    act(() => {
      ref.current!.applyQuickAction(pending({ prompt: 'warm' }), 'send');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(handleSend).toHaveBeenCalledTimes(1);
    expect(handleSend.mock.calls[0]![0]).toBe('warm');
  });
});

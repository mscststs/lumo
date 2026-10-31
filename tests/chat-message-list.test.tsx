// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import type { ChatMessage, Conversation } from '@/types';

// `ChatMessageList` pulls in i18n, motion and Streamdown. None of them matter
// for reconciliation, so stub the leaves down to a marker element that carries
// the message id — that is all we need to track DOM identity.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message, isStreaming }: { message: ChatMessage; isStreaming?: boolean }) => (
    <div data-msg-id={message.id} data-streaming={isStreaming ? 'yes' : 'no'} />
  ),
}));

vi.mock('@/components/chat/CompactionDivider', () => ({
  CompactionDivider: ({ compaction }: { compaction: { summary: string } }) => (
    <div data-compaction>{compaction.summary}</div>
  ),
}));

vi.mock('@/components/chat/ChatError', () => ({
  ChatError: () => <div data-chat-error />,
  classifyError: () => ({ category: 'unknown', message: '' }),
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: () => Promise.resolve({
      language: 'auto',
      theme: 'system',
      fontSize: 14,
      maxSplitPanels: 1,
      sendKey: 'enter',
      pasteThreshold: 0,
      maxSteps: 0,
      messageToolbar: { copy: 'all', regenerate: 'show', delete: 'all', usage: 'show' },
    }),
  },
}));

vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: () => {},
}));

let ChatMessageList: typeof import('@/components/chat/ChatMessageList').ChatMessageList;

beforeAll(async () => {
  ({ ChatMessageList } = await import('@/components/chat/ChatMessageList'));
});

function conversation(messages: ChatMessage[]): Conversation {
  return {
    id: 'conv-1',
    title: 'test',
    messages,
    modelId: 'm',
    providerId: 'p',
    createdAt: 0,
    updatedAt: 0,
  };
}

const userMessage: ChatMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hi', state: 'done' }],
  timestamp: 1,
};

function assistant(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text, state: 'done' }],
    timestamp: 2,
  };
}

const baseProps = {
  chatError: null,
  isRetrying: false,
  retryAttempt: 0,
  hasModels: true,
  onRetry: () => {},
};

/**
 * The flicker was a remount: when the finished turn moved from the streaming
 * slot into the persisted list, React tore the subtree down and built it again,
 * replaying the entry animation over content the user had already read. A
 * remount is observable as a fresh DOM node, so assert on node identity.
 *
 * Panel index is irrelevant to this component — it takes no panel prop and the
 * whole chat subtree is instantiated per panel by ChatPanel — so one pass proves
 * the behaviour for all three panels. The parametrised loop documents that.
 */
describe.each([0, 1, 2])('ChatMessageList streaming hand-off (panel %i)', () => {
  it('reuses the assistant DOM node when the stream finishes', () => {
    const assistantId = 'assistant-1';

    const { container, rerender } = render(
      <ChatMessageList
        {...baseProps}
        currentConversation={conversation([userMessage])}
        isStreaming
        streamingMessage={assistant(assistantId, 'partial')}
      />,
    );

    const before = container.querySelector(`[data-msg-id="${assistantId}"]`) as HTMLElement;
    expect(before).not.toBeNull();
    expect(before.dataset.streaming).toBe('yes');
    // Tag the node so a remount is unmistakable.
    before.dataset.marker = 'original';

    // Stream finishes: the turn is now part of the conversation and the live
    // copy is gone — exactly what `persist` commits in one batch.
    rerender(
      <ChatMessageList
        {...baseProps}
        currentConversation={conversation([userMessage, assistant(assistantId, 'complete')])}
        isStreaming={false}
        streamingMessage={null}
      />,
    );

    const after = container.querySelector(`[data-msg-id="${assistantId}"]`) as HTMLElement;
    expect(after).not.toBeNull();
    expect(after).toBe(before);
    expect(after.dataset.marker).toBe('original');
    expect(after.dataset.streaming).toBe('no');
  });

  it('never renders the turn twice during the hand-off', () => {
    const assistantId = 'assistant-1';
    const finished = assistant(assistantId, 'complete');

    const { container } = render(
      <ChatMessageList
        {...baseProps}
        // Worst case: storage already holds the turn while the streaming copy
        // has not been cleared yet.
        currentConversation={conversation([userMessage, finished])}
        isStreaming
        streamingMessage={assistant(assistantId, 'partial')}
      />,
    );

    expect(container.querySelectorAll(`[data-msg-id="${assistantId}"]`)).toHaveLength(1);
  });

  it('keeps the streamed transcript mounted when the turn ends without being saved', () => {
    const assistantId = 'assistant-1';

    const { container, rerender } = render(
      <ChatMessageList
        {...baseProps}
        currentConversation={conversation([userMessage])}
        isStreaming
        streamingMessage={assistant(assistantId, 'partial')}
      />,
    );

    const before = container.querySelector(`[data-msg-id="${assistantId}"]`) as HTMLElement;
    before.dataset.marker = 'original';

    // Stop / error path: streaming stops but the turn stays on screen.
    rerender(
      <ChatMessageList
        {...baseProps}
        currentConversation={conversation([userMessage])}
        isStreaming={false}
        streamingMessage={assistant(assistantId, 'partial')}
      />,
    );

    const after = container.querySelector(`[data-msg-id="${assistantId}"]`) as HTMLElement;
    expect(after).toBe(before);
    expect(after.dataset.marker).toBe('original');
  });
});

describe('ChatMessageList compaction seam', () => {
  it('renders the checkpoint at the chronological trigger position', () => {
    const boundary: ChatMessage = {
      id: 'user-2',
      role: 'user',
      parts: [{ type: 'text', text: 'new question', state: 'done' }],
      timestamp: 3,
    };
    const conv = conversation([userMessage, assistant('assistant-1', 'old answer'), boundary]);
    conv.compaction = {
      summary: 'COMPACTED SUMMARY',
      // The prompt projection starts at the older assistant message...
      firstKeptMessageId: 'assistant-1',
      // ...but the seam is an event, drawn after the newest message at the time.
      triggeredAtMessageId: 'user-2',
      tokensBefore: 1234,
      createdAt: 10,
    };

    const { container } = render(
      <ChatMessageList
        {...baseProps}
        currentConversation={conv}
        isStreaming={false}
        streamingMessage={null}
      />,
    );

    const divider = container.querySelector('[data-compaction]');
    const anchorNode = container.querySelector('[data-msg-id="user-2"]');
    expect(divider).not.toBeNull();
    expect(divider!.textContent).toContain('COMPACTED SUMMARY');
    expect(anchorNode).not.toBeNull();
    // The seam comes *after* the trigger message (i.e. the trigger precedes it).
    expect(
      divider!.compareDocumentPosition(anchorNode!) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it('renders no seam without a checkpoint', () => {
    const { container } = render(
      <ChatMessageList
        {...baseProps}
        currentConversation={conversation([userMessage, assistant('assistant-1', 'reply')])}
        isStreaming={false}
        streamingMessage={null}
      />,
    );
    expect(container.querySelector('[data-compaction]')).toBeNull();
  });
});

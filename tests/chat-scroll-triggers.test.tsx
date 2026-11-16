// @vitest-environment jsdom
/**
 * How the transcript drives its scroll controller.
 *
 * The controller itself is faked here; what is under test is the *trigger*
 * policy the two modes share: the newest question on screen is the anchor, so
 * showing a conversation and sending a message both hand it over, while a new
 * assistant turn (regenerate / retry) is reported separately — the anchored
 * controller ignores that one, `auto` follows it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ChatMessage, Conversation } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: ChatMessage }) => <div data-msg-id={message.id} />,
}));

vi.mock('@/components/chat/CompactionDivider', () => ({
  CompactionDivider: () => <div data-compaction />,
}));

vi.mock('@/components/chat/ChatError', () => ({
  ChatError: () => <div data-chat-error />,
  classifyError: () => ({ category: 'unknown', message: '' }),
}));

vi.mock('@/store/storage', () => ({
  storage: { getUISettings: async () => ({}) },
}));

vi.mock('@/store/useStorageWatch', () => ({ useStorageWatch: () => {} }));

const state = vi.hoisted(() => ({
  mode: 'anchor' as 'anchor' | 'auto',
  calls: [] as string[],
}));

vi.mock('@/components/chat/useChatScrollMode', () => ({
  useChatScrollMode: () => state.mode,
}));

vi.mock('@/components/chat/useChatScroll', () => {
  const controller = (kind: string) => ({
    scrollRef: () => {},
    contentRef: () => {},
    isAtBottom: true,
    scrollToBottom: () => state.calls.push(`${kind}:bottom`),
    onUserMessageSent: (id: string) => state.calls.push(`${kind}:sent:${id}`),
    onTranscriptShown: (id: string) => state.calls.push(`${kind}:shown:${id}`),
    onStreamStart: () => state.calls.push(`${kind}:stream`),
  });
  return {
    useAutoChatScroll: () => controller('auto'),
    useAnchorChatScroll: () => controller('anchor'),
  };
});

let ChatMessageList: typeof import('@/components/chat/ChatMessageList').ChatMessageList;

beforeAll(async () => {
  ({ ChatMessageList } = await import('@/components/chat/ChatMessageList'));
});

beforeEach(() => {
  state.mode = 'anchor';
  state.calls = [];
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

const firstQuestion: ChatMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hi', state: 'done' }],
  timestamp: 1,
};

function assistant(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: 'reply', state: 'done' }],
    timestamp: 2,
  };
}

const answer: ChatMessage = assistant('assistant-1');

function props(messages: ChatMessage[], isStreaming = false) {
  return {
    currentConversation: conversation(messages),
    isStreaming,
    streamingMessage: null,
    chatError: null,
    isRetrying: false,
    retryAttempt: 0,
    hasModels: true,
    onRetry: () => {},
  } as const;
}

afterEach(() => {
  cleanup();
});

describe('transcript scroll triggers', () => {
  it('holds the newest question as soon as a conversation is shown', () => {
    render(<ChatMessageList {...props([firstQuestion, answer])} />);
    expect(state.calls).toContain('anchor:shown:user-1');
  });

  it('picks the newest question, not the first one', () => {
    const secondQuestion: ChatMessage = {
      id: 'user-2',
      role: 'user',
      parts: [{ type: 'text', text: 'again', state: 'done' }],
      timestamp: 3,
    };
    render(<ChatMessageList {...props([firstQuestion, answer, secondQuestion])} />);
    expect(state.calls).toContain('anchor:shown:user-2');
    expect(state.calls).not.toContain('anchor:shown:user-1');
  });

  it('reports a send and a new turn separately', () => {
    const { rerender } = render(<ChatMessageList {...props([firstQuestion, answer])} />);
    state.calls = [];

    const secondQuestion: ChatMessage = {
      id: 'user-2',
      role: 'user',
      parts: [{ type: 'text', text: 'again', state: 'done' }],
      timestamp: 3,
    };
    rerender(
      <ChatMessageList {...props([firstQuestion, answer, secondQuestion], true)} />,
    );

    expect(state.calls).toContain('anchor:sent:user-2');
    expect(state.calls).toContain('anchor:stream');
    expect(state.calls).not.toContain('anchor:bottom');
  });

  it('does not re-hold when older history is edited', () => {
    const secondQuestion: ChatMessage = {
      id: 'user-2',
      role: 'user',
      parts: [{ type: 'text', text: 'again', state: 'done' }],
      timestamp: 3,
    };
    const { rerender } = render(
      <ChatMessageList {...props([firstQuestion, answer, secondQuestion])} />,
    );
    state.calls = [];

    // Deleting the newest question shrinks the transcript; the reader must not
    // be dragged to whichever question is left.
    rerender(<ChatMessageList {...props([firstQuestion, answer])} />);
    expect(state.calls).toEqual([]);
  });

  it('does not re-hold on every stream tick', () => {
    const { rerender } = render(<ChatMessageList {...props([firstQuestion], true)} />);
    state.calls = [];

    rerender(<ChatMessageList {...props([firstQuestion], true)} />);
    // Same question, same turn: nothing to re-anchor, nothing to follow.
    expect(state.calls).toEqual([]);
  });
});

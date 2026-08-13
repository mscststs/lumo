import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import {
  Conversation as ConversationContainer,
  ConversationContent,
  ConversationScrollButton,
  useConversationScroll,
} from '@/components/ai-elements/conversation';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ChatError } from '@/components/chat/ChatError';
import { MAX_RETRIES } from '@/lib/retry-policy';
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import type { ChatMessage, Conversation } from '@/types';

interface ChatMessageListProps {
  currentConversation: Conversation | null;
  isStreaming: boolean;
  /** The in-flight assistant turn, or `null` when it has nothing to show yet. */
  streamingMessage: ChatMessage | null;
  chatError: ChatErrorInfo | null;
  isRetrying: boolean;
  retryAttempt: number;
  hasModels: boolean;
  onRetry: () => void;
}

export function ChatMessageList({
  currentConversation,
  isStreaming,
  streamingMessage,
  chatError,
  isRetrying,
  retryAttempt,
  hasModels,
  onRetry,
}: ChatMessageListProps) {
  const { t } = useTranslation();
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useConversationScroll();

  const persisted = currentConversation?.messages ?? [];

  // ─── Auto-scroll to bottom when the user sends a new message ────────────
  // When the user is scrolled up reviewing history and then sends a message,
  // `use-stick-to-bottom` correctly does NOT auto-follow (it respects the
  // scroll position). But the user expectation after sending is to see their
  // new message and the incoming reply, so we force-scroll on:
  //   1. A new user message appearing (last message switches to role 'user')
  //   2. Streaming starts (isStreaming flips true → assistant turn begins)
  const prevMessageCountRef = useRef(persisted.length);
  const prevIsStreamingRef = useRef(isStreaming);

  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = persisted.length;

    // A new user message was appended
    if (persisted.length > prevCount) {
      const lastMsg = persisted[persisted.length - 1];
      if (lastMsg?.role === 'user') {
        scrollToBottom();
      }
    }
  }, [persisted.length, scrollToBottom]);

  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    // Streaming just started — scroll so the user sees the thinking indicator
    if (isStreaming && !wasStreaming) {
      scrollToBottom();
    }
  }, [isStreaming, scrollToBottom]);
  // The streamed turn is persisted under the id it streamed under, so once the
  // conversation contains it the live copy must step aside — otherwise the reply
  // would briefly appear twice.
  const pending =
    streamingMessage && !persisted.some((msg) => msg.id === streamingMessage.id)
      ? streamingMessage
      : null;

  // Persisted and in-flight messages must live in ONE array, not in an array
  // plus a trailing conditional slot. React scopes keys to a position among
  // siblings: a keyed element sitting in its own JSX slot is a different
  // position from the same key inside the mapped array, so when the finished
  // turn moved from the slot into the array React unmounted and remounted it —
  // discarding the DOM and replaying MessageBubble's entry animation. Keeping
  // both in one list makes the hand-off a plain in-place update.
  const rendered = pending ? [...persisted, pending] : persisted;

  return (
    <ConversationContainer className="flex-1">
      <ConversationContent scrollRef={scrollRef} contentRef={contentRef}>
        {!hasModels && (
          <div className="text-center text-muted-foreground text-sm py-8">
            {t('sidebar.noModels')}
          </div>
        )}
        {rendered.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isStreaming={isStreaming && msg.id === pending?.id}
          />
        ))}
        {isStreaming && !pending && !chatError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 text-muted-foreground text-sm py-1"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
            {t('sidebar.thinking')}
          </motion.div>
        )}
        {/* Error display with retry controls */}
        <AnimatePresence>
          {chatError && (
            <ChatError
              error={chatError}
              isRetrying={isRetrying}
              retryAttempt={retryAttempt}
              maxRetries={MAX_RETRIES}
              onRetry={onRetry}
            />
          )}
        </AnimatePresence>
      </ConversationContent>
      <ConversationScrollButton isAtBottom={isAtBottom} scrollToBottom={scrollToBottom} />
    </ConversationContainer>
  );
}

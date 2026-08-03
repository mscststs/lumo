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
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import type { ChatMessage, Conversation } from '@/types';

const MAX_RETRIES = 3;

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

  const messages = currentConversation?.messages ?? [];
  // The streamed turn is persisted under the id it streamed under, so once the
  // conversation contains it the live copy must step aside — otherwise the reply
  // would briefly appear twice.
  const pending =
    streamingMessage && !messages.some((msg) => msg.id === streamingMessage.id)
      ? streamingMessage
      : null;

  return (
    <ConversationContainer className="flex-1">
      <ConversationContent scrollRef={scrollRef} contentRef={contentRef}>
        {!hasModels && (
          <div className="text-center text-muted-foreground text-sm py-8">
            {t('sidebar.noModels')}
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {/*
          Rendered as a `MessageBubble` keyed by the assistant id it will be
          saved under. When the turn finishes, the persisted message takes over
          this exact key and slot, so React patches the existing DOM instead of
          unmounting the live bubble and mounting a fresh one — which is what
          made the completed reply flash and replay its entry animation.
        */}
        {pending && (
          <MessageBubble key={pending.id} message={pending} isStreaming={isStreaming} />
        )}
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

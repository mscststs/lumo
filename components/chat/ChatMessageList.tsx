import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  Conversation as ConversationContainer,
  ConversationContent,
  ConversationScrollButton,
  useConversationScroll,
} from '@/components/ai-elements/conversation';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { MessagePartList } from '@/components/chat/MessagePartList';
import { ChatError } from '@/components/chat/ChatError';
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import type { ChatMessagePart, Conversation } from '@/types';

const MAX_RETRIES = 3;

interface ChatMessageListProps {
  currentConversation: Conversation | null;
  isStreaming: boolean;
  isStreamingVisible: boolean;
  streamingParts: ChatMessagePart[];
  chatError: ChatErrorInfo | null;
  isRetrying: boolean;
  retryAttempt: number;
  hasModels: boolean;
  onRetry: () => void;
}

export function ChatMessageList({
  currentConversation,
  isStreaming,
  isStreamingVisible,
  streamingParts,
  chatError,
  isRetrying,
  retryAttempt,
  hasModels,
  onRetry,
}: ChatMessageListProps) {
  const { t } = useTranslation();
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useConversationScroll();

  return (
    <ConversationContainer className="flex-1">
      <ConversationContent scrollRef={scrollRef} contentRef={contentRef}>
        {!hasModels && (
          <div className="text-center text-muted-foreground text-sm py-8">
            {t('sidebar.noModels')}
          </div>
        )}
        {currentConversation?.messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {isStreaming && isStreamingVisible && (
          <Message from="assistant">
            <MessageContent>
              <MessagePartList parts={streamingParts} isStreaming />
            </MessageContent>
          </Message>
        )}
        {isStreaming && !isStreamingVisible && !chatError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 text-muted-foreground text-sm py-1"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
            {t('sidebar.thinking')}
          </motion.div>
        )}
        {/* Show partial content when retrying (content streamed before error) */}
        {!isStreaming && streamingParts.length > 0 && chatError && (
          <Message from="assistant">
            <MessageContent>
              <MessagePartList parts={streamingParts} />
            </MessageContent>
          </Message>
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

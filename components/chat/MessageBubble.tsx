import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Copy } from 'lucide-react';
import {
  Message,
  MessageContent,
  MessageActions,
  MessageAction,
} from '@/components/ai-elements/message';
import { MessagePartList } from './MessagePartList';
import { extractText, normalizeMessage } from '@/lib/message-parts';
import type { ChatMessage, ChatMessagePart } from '@/types';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const parts = normalizeMessage(message);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <Message from={message.role}>
        <MessageContent>
          {isUser ? (
            <UserMessageBody parts={parts} />
          ) : (
            <MessagePartList parts={parts} isStreaming={isStreaming} />
          )}
        </MessageContent>

        {!isUser && !isStreaming && (
          <MessageActions>
            <MessageAction
              label={t('sidebar.copy')}
              tooltip={t('sidebar.copy')}
              onClick={() => navigator.clipboard.writeText(extractText(parts))}
            >
              <Copy className="size-3" />
            </MessageAction>
          </MessageActions>
        )}
      </Message>
    </motion.div>
  );
}

/** User messages are plain text plus attachments — no markdown, no tools. */
function UserMessageBody({ parts }: { parts: ChatMessagePart[] }) {
  const images = parts.filter(
    (part): part is Extract<ChatMessagePart, { type: 'file' }> =>
      part.type === 'file' && part.mediaType.startsWith('image'),
  );
  const text = extractText(parts);

  return (
    <>
      {images.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {images.map((image, index) => (
            <img
              key={`${image.url.slice(-24)}-${index}`}
              src={image.url}
              className="h-20 w-20 rounded object-cover"
              alt={image.filename ?? ''}
            />
          ))}
        </div>
      )}
      {text && <span className="whitespace-pre-wrap break-words">{text}</span>}
    </>
  );
}

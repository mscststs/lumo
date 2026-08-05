import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, FileText, ChevronDown, ChevronUp, Image as ImageIcon } from 'lucide-react';
import { LUMO_FILE_REF_MIME, LUMO_IMAGE_DRAG_MIME } from '@/lib/constants';
import {
  Message,
  MessageContent,
  MessageActions,
  MessageAction,
} from '@/components/ai-elements/message';
import { MessagePartList } from './MessagePartList';
import { extractText, normalizeMessage } from '@/lib/message-parts';
import type { ChatMessage, ChatMessagePart, TextAttachment } from '@/types';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming = false,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const parts = normalizeMessage(message);

  if (isUser) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <Message from="user" className="gap-2">
          {/* Attachments rendered OUTSIDE the bubble */}
          <UserAttachments parts={parts} textAttachments={message.textAttachments} />

          {/* User text bubble */}
          <UserTextBubble parts={parts} textAttachments={message.textAttachments} />
        </Message>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <Message from="assistant">
        <MessageContent>
          <MessagePartList parts={parts} isStreaming={isStreaming} />
        </MessageContent>

        {!isStreaming && (
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
});

/** Attachment cards rendered outside the message bubble. */
function UserAttachments({ parts, textAttachments }: { parts: ChatMessagePart[]; textAttachments?: TextAttachment[] }) {
  const images = parts.filter(
    (part): part is Extract<ChatMessagePart, { type: 'file' }> =>
      part.type === 'file' && part.mediaType.startsWith('image'),
  );

  const hasAttachments = images.length > 0 || (textAttachments && textAttachments.length > 0);
  if (!hasAttachments) return null;

  return (
    <div className="flex flex-col gap-1.5 max-w-[85%]">
      {/* Image attachment cards */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 justify-end">
          {images.map((image, index) => (
            <ImageAttachmentCard key={`${image.url.slice(-24)}-${index}`} image={image} />
          ))}
        </div>
      )}

      {/* Text attachment cards */}
      {textAttachments && textAttachments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {textAttachments.map((attachment) => (
            <TextAttachmentCard key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The user text inside a bubble (MessageContent). Only renders if there's text. */
function UserTextBubble({ parts, textAttachments }: { parts: ChatMessagePart[]; textAttachments?: TextAttachment[] }) {
  const textParts = parts.filter(
    (part): part is Extract<ChatMessagePart, { type: 'text' }> => part.type === 'text',
  );

  let userText: string;
  if (textAttachments && textAttachments.length > 0 && textParts.length > textAttachments.length) {
    userText = textParts[textParts.length - 1]?.text ?? '';
  } else if (textAttachments && textAttachments.length > 0 && textParts.length === textAttachments.length) {
    userText = '';
  } else {
    userText = extractText(parts);
  }

  if (!userText) return null;

  return (
    <MessageContent>
      <span className="whitespace-pre-wrap break-words">{userText}</span>
    </MessageContent>
  );
}

/** Image attachment rendered as a card with border and click-to-expand. */
function ImageAttachmentCard({ image }: { image: Extract<ChatMessagePart, { type: 'file' }> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    // Set the image URL as draggable HTML (img tag) so the global drop handler
    // can detect it as an image drag, same as dragging from a web page.
    e.dataTransfer.setData(LUMO_IMAGE_DRAG_MIME, image.url);
    e.dataTransfer.setData('text/html', `<img src="${image.url}" />`);
    e.dataTransfer.setData('text/plain', image.url);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <>
      <div
        className="relative group cursor-pointer rounded-lg border border-border overflow-hidden bg-muted/30 active:cursor-grabbing"
        onClick={() => setExpanded(true)}
        draggable
        onDragStart={handleDragStart}
      >
        <img
          src={image.url}
          className="h-20 w-20 object-cover"
          alt={image.filename ?? ''}
        />
        {/* Hover affordance painted over the user's own image pixels, not over a
            themed surface — so this stays a fixed dark wash rather than using
            `bg-overlay`, and the icon keeps a literal `text-white`. Tying it to
            a theme token would make the icon illegible on light themes. */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
          <ImageIcon className="h-4 w-4 text-white" />
        </div>
      </div>

      {/* Expanded overlay */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            // Same role as the dialog scrim, so it shares the `overlay` token:
            // always a dark wash, tuned per palette (see assets/globals.css).
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
            onClick={() => setExpanded(false)}
          >
            <motion.img
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.8 }}
              src={image.url}
              className="max-w-full max-h-full rounded-lg shadow-lg object-contain"
              alt={image.filename ?? t('sidebar.imageAttachment')}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Text/HTML attachment rendered as a collapsible card. */
function TextAttachmentCard({ attachment }: { attachment: TextAttachment }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const isHtml = attachment.mediaType === 'text/html';
  const label = attachment.label
    ?? (attachment.kind === 'file-ref' ? t('sidebar.files.file') : null)
    ?? (isHtml ? 'HTML' : t('sidebar.textAttachment'));

  const handleDragStart = (e: React.DragEvent) => {
    if (attachment.kind === 'file-ref') {
      // Extract file name from content format `[file: name]`
      const match = /^\[file:\s*(.+)\]$/.exec(attachment.content);
      const fileName = match?.[1] ?? attachment.preview;
      e.dataTransfer.setData(LUMO_FILE_REF_MIME, fileName);
      e.dataTransfer.setData('text/plain', attachment.content);
    } else {
      if (isHtml) {
        e.dataTransfer.setData('text/html', attachment.content);
      }
      e.dataTransfer.setData('text/plain', attachment.content);
    }
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      className="rounded-lg border border-border bg-muted/30 overflow-hidden text-sm active:cursor-grabbing"
      draggable
      onDragStart={handleDragStart}
    >
      {/* Header */}
      <button
        className="flex items-center gap-2 w-full px-2.5 py-1.5 hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground/70 truncate flex-1 text-left">
          {attachment.preview}
        </span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* Expandable content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-2.5 py-2 border-t border-border max-h-[200px] overflow-y-auto scrollbar-lumo">
              {isHtml ? (
                <div
                  className="text-xs prose prose-sm dark:prose-invert max-w-none break-words"
                  dangerouslySetInnerHTML={{ __html: attachment.content }}
                />
              ) : (
                <pre className="text-xs whitespace-pre-wrap break-words text-foreground/80">
                  {attachment.content}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

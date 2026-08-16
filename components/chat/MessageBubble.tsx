import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, FileText, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Image as ImageIcon, Globe, CircleSlash, Trash2, Activity, RefreshCw } from 'lucide-react';
import { attachmentLabel } from '@/lib/attachment-display';
import { LUMO_ATTACHMENT_MIME, LUMO_IMAGE_DRAG_MIME } from '@/lib/constants';
import { parseFileRefContent, setFileRefDragData } from '@/lib/file-drag';
import {
  Message,
  MessageContent,
  MessageActions,
  MessageAction,
} from '@/components/ai-elements/message';
import { TokenUsageTooltip } from './TokenUsageTooltip';
import { MessagePartList } from './MessagePartList';
import { extractText, normalizeMessage } from '@/lib/message-parts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ChatMessage, ChatMessagePart, ChatMessageVariant, TextAttachment, MessageToolbarSettings } from '@/types';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSwitchVariant?: (variantIndex: number) => void;
  /** Whether this is the last assistant message in the conversation. */
  isLastAssistant?: boolean;
  /** Number of messages that will be removed (this one + all after it). */
  deleteCount?: number;
  /** Per-action visibility from UISettings. */
  toolbar?: MessageToolbarSettings;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming = false,
  onDelete,
  onRegenerate,
  onSwitchVariant,
  isLastAssistant = false,
  deleteCount = 1,
  toolbar,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const parts = normalizeMessage(message);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Toolbar visibility helpers
  const showCopy = toolbar
    ? (isUser ? (toolbar.copy === 'all' || toolbar.copy === 'user') : (toolbar.copy === 'all' || toolbar.copy === 'assistant'))
    : true;
  const showDelete = toolbar
    ? (isUser ? (toolbar.delete === 'all' || toolbar.delete === 'user') : (toolbar.delete === 'all' || toolbar.delete === 'assistant'))
    : true;
  const showRegenerate = toolbar ? toolbar.regenerate === 'show' : true;
  const showUsage = toolbar ? toolbar.usage === 'show' : true;

  // Resolve variant-aware metadata for the displayed version.
  const activeVariant =
    message.variants &&
    message.activeVariantIndex !== undefined &&
    message.activeVariantIndex < message.variants.length
      ? message.variants[message.activeVariantIndex]
      : undefined;
  const activeInterrupted = activeVariant ? activeVariant.interrupted : message.interrupted;
  const activeStopReason = activeVariant ? activeVariant.stopReason : message.stopReason;
  const activeUsage = activeVariant ? activeVariant.usage : message.usage;

  const confirmDelete = useCallback(() => {
    setConfirmOpen(false);
    onDelete?.(message.id);
  }, [onDelete, message.id]);

  const deleteDialog = onDelete && (
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{t('sidebar.deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('sidebar.deleteConfirmDesc', { count: deleteCount })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={confirmDelete}>
            {t('sidebar.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (isUser) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <Message from="user" className="gap-2">
          {/* Attachments rendered OUTSIDE the bubble */}
          <UserAttachments parts={parts} textAttachments={message.textAttachments} />

          {/* User text bubble */}
          <UserTextBubble parts={parts} textAttachments={message.textAttachments} />

          {(showCopy || (onDelete && showDelete)) && (
            <MessageActions>
              {showCopy && (
                <MessageAction
                  label={t('sidebar.copy')}
                  tooltip={t('sidebar.copy')}
                  onClick={() => navigator.clipboard.writeText(extractText(parts))}
                >
                  <Copy className="size-3" />
                </MessageAction>
              )}
              {onDelete && showDelete && (
                <MessageAction
                  label={t('sidebar.delete')}
                  tooltip={t('sidebar.delete')}
                  onClick={() => setConfirmOpen(true)}
                >
                  <Trash2 className="size-3" />
                </MessageAction>
              )}
            </MessageActions>
          )}
        </Message>
        {deleteDialog}
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <Message from="assistant">
        <MessageContent>
          <MessagePartList parts={parts} isStreaming={isStreaming} />
        </MessageContent>

        {/* Only meaningful once the turn has settled: while streaming, a reply
            being unfinished is the expected state, not something to flag. */}
        {!isStreaming && activeInterrupted && (
          <InterruptedNotice stopReason={activeStopReason} />
        )}

        {!isStreaming && (
          <MessageActions>
            {/* Variant switcher — only on the last assistant message with variants */}
            {isLastAssistant && message.variants && message.variants.length > 0 && onSwitchVariant && (
              <VariantSwitcher
                variants={message.variants}
                activeVariantIndex={message.activeVariantIndex}
                onSwitch={onSwitchVariant}
              />
            )}
            {showCopy && (
              <MessageAction
                label={t('sidebar.copy')}
                tooltip={t('sidebar.copy')}
                onClick={() => navigator.clipboard.writeText(extractText(parts))}
              >
                <Copy className="size-3" />
              </MessageAction>
            )}
            {isLastAssistant && onRegenerate && showRegenerate && (
              <MessageAction
                label={t('sidebar.regenerate')}
                tooltip={t('sidebar.regenerate')}
                onClick={() => onRegenerate(message.id)}
              >
                <RefreshCw className="size-3" />
              </MessageAction>
            )}
            {onDelete && showDelete && (
              <MessageAction
                label={t('sidebar.delete')}
                tooltip={t('sidebar.delete')}
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="size-3" />
              </MessageAction>
            )}
            {showUsage && activeUsage && (
              <TokenUsageTooltip usage={activeUsage} />
            )}
          </MessageActions>
        )}
      </Message>
      {deleteDialog}
    </motion.div>
  );
});

// ─── VariantSwitcher ────────────────────────────────────────────────────────

interface VariantSwitcherProps {
  variants: ChatMessageVariant[];
  activeVariantIndex?: number;
  onSwitch: (index: number) => void;
}

/**
 * Compact left/right navigation for switching between regeneration variants.
 *
 * Shows "2 / 3" with arrow buttons. The total count is `variants.length + 1`
 * because the current message parts are the latest (un-archived) generation.
 * `activeVariantIndex` points into `variants` when an older version is shown;
 * `undefined` means the latest is active (displayed as the last slot).
 */
function VariantSwitcher({ variants, activeVariantIndex, onSwitch }: VariantSwitcherProps) {
  const total = variants.length + 1;
  // Active slot: undefined / >= variants.length → last slot (latest)
  const currentSlot = activeVariantIndex !== undefined && activeVariantIndex < variants.length
    ? activeVariantIndex
    : variants.length;
  const displayIndex = currentSlot + 1; // 1-based for display

  const canPrev = currentSlot > 0;
  const canNext = currentSlot < total - 1;

  return (
    <div className="flex items-center gap-0">
      <button
        className="h-6 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
        disabled={!canPrev}
        onClick={() => canPrev && onSwitch(currentSlot - 1)}
        aria-label="Previous variant"
      >
        <ChevronLeft className="size-3" />
      </button>
      <span className="text-xs tabular-nums text-muted-foreground select-none min-w-[2rem] text-center">
        {displayIndex}/{total}
      </span>
      <button
        className="h-6 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
        disabled={!canNext}
        onClick={() => canNext && onSwitch(currentSlot + 1)}
        aria-label="Next variant"
      >
        <ChevronRight className="size-3" />
      </button>
    </div>
  );
}

/**
 * Marks a reply that stopped before the model was done — the user hit stop, the
 * panel was closed mid-stream, the request failed partway, or the configured
 * tool step limit ran out.
 *
 * Without it a truncated answer is indistinguishable from a complete one, which
 * is worse than not persisting it at all: the user would trust a cut-off answer.
 * `min-w-0` + `break-words` because the side panel is user-resizable down to a
 * narrow column, where an unwrapped label would force the bubble to overflow.
 *
 * The step-limit wording is separate because it is the one cause the user can do
 * something about: the generic label would send them hunting for a failure that
 * never happened, when the fix is a setting.
 *
 * The assistant `Message` is a gapless column — only the user variant sets one —
 * so every direct child owns its own separation from the reply above it, the way
 * `MessageActions` does with `pt-1`. Without `pt-1.5` this label sat flush
 * against the last line of prose and read as part of the answer.
 */
function InterruptedNotice({ stopReason }: { stopReason?: 'step-limit' }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-1.5 pt-1.5 text-xs text-muted-foreground">
      <CircleSlash className="h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">
        {t(stopReason === 'step-limit' ? 'sidebar.stepLimit' : 'sidebar.interrupted')}
      </span>
    </div>
  );
}

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
  const label = attachmentLabel(attachment, t);

  const handleDragStart = (e: React.DragEvent) => {
    // Internal sidebar drops receive the whole attachment so the chip round-trips
    // exactly (kind/label/mediaType preserved) instead of degrading to plain text.
    e.dataTransfer.setData(LUMO_ATTACHMENT_MIME, JSON.stringify(attachment));

    if (attachment.kind === 'file-ref') {
      setFileRefDragData(e.dataTransfer, parseFileRefContent(attachment.content) ?? attachment.preview);
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
        {attachment.kind === 'page-context' ? (
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
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

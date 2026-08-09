import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, ImagePlus, X, FileText, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { attachmentLabel } from '@/lib/attachment-display';
import { LUMO_ATTACHMENT_MIME, LUMO_FILE_REF_MIME, LUMO_IMAGE_DRAG_MIME } from '@/lib/constants';
import { DEFAULT_PASTE_THRESHOLD, shouldAttachPaste } from '@/lib/paste-threshold';
import { createTextAttachment } from '@/lib/text-attachment';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { SendKey, TextAttachment, UISettings } from '@/types';

/**
 * How tall the composer may grow before it scrolls instead, in lines.
 *
 * The pixel cap it produces is applied as an inline `maxHeight` rather than a
 * Tailwind `max-h-[…]` class. The auto-grow effect below already has to compute
 * the bound in JS to size the element, and a class would state the same number a
 * second time somewhere that effect cannot read — so raising the line count
 * would visibly do nothing until someone noticed the stale class.
 */
const MAX_INPUT_LINES = 5;
/** `text-sm` line-height (1.25rem) in px. */
const LINE_HEIGHT = 20;
const MAX_INPUT_HEIGHT = MAX_INPUT_LINES * LINE_HEIGHT;

export interface ChatInputHandle {
  focus: () => void;
  addImages: (dataUrls: string[]) => void;
  addTextAttachment: (attachment: TextAttachment) => void;
  /**
   * Whether the input holds anything the user would lose. Quick-action routing
   * uses this to avoid landing a generated prompt on top of a draft.
   */
  hasContent: () => boolean;
  /**
   * Writes `text` into the input. An existing draft is kept and the text is
   * appended on a new line, so a quick action can never silently discard what
   * the user typed.
   */
  prefill: (text: string) => void;
}
 
interface ChatInputProps {
  isStreaming: boolean;
  isVisionModel: boolean;
  onSend: (input: string, images: string[], textAttachments: TextAttachment[]) => void;
  onStop: () => void;
  /** Whether the current drag originates from within the sidebar */
  isInternalDrag: boolean;
  onInternalFileDrop?: (fileName: string) => void;
  onInternalTextDrop?: (text: string) => void;
  /** Receives a re-attached `TextAttachment` drag that carried a full attachment payload. */
  onInternalAttachmentDrop?: (attachment: TextAttachment) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { isStreaming, isVisionModel, onSend, onStop, isInternalDrag, onInternalFileDrop, onInternalTextDrop, onInternalAttachmentDrop },
  ref,
) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [isInternalDragOver, setIsInternalDragOver] = useState(false);
  const [sendKey, setSendKey] = useState<SendKey>('enter');
  const [pasteThreshold, setPasteThreshold] = useState(DEFAULT_PASTE_THRESHOLD);
  const internalDragCounterRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setSendKey(settings.sendKey ?? 'enter');
      setPasteThreshold(settings.pasteThreshold);
    });
  }, []);

  // React live to input-behaviour changes made in the options page.
  useStorageWatch<UISettings>('uiSettings', (newVal) => {
    if (!newVal) return;
    setSendKey(newVal.sendKey ?? 'enter');
    setPasteThreshold(newVal.pasteThreshold);
  });

  // Auto-grow the textarea to fit content, up to MAX_INPUT_LINES rows, after
  // which a scrollbar appears instead of expanding further.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const resize = () => {
      el.style.height = 'auto';
      const next = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT);
      if (el.clientHeight !== next) {
        el.style.height = `${next}px`;
      }
    };

    // Re-measure whenever the content (input) changes.
    resize();

    // Re-measure when the element resizes too. This matters because the chat
    // panel animates in from width 0 on open — the first measurement taken
    // then can be wrong (the placeholder wraps → height pinned at max). It
    // also keeps the height correct when the sidebar/panel width changes and
    // the text re-wraps.
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [input]);
 
  // The handle closes over `input`/`images`/`textAttachments`, so it must be
  // rebuilt when they change — otherwise `hasContent` reports a stale draft and
  // quick-action routing would overwrite text the user just typed.
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    addImages: (dataUrls: string[]) => {
      setImages((prev) => [...prev, ...dataUrls]);
    },
    addTextAttachment: (attachment: TextAttachment) => {
      setTextAttachments((prev) => [...prev, attachment]);
    },
    hasContent: () =>
      input.trim().length > 0 || images.length > 0 || textAttachments.length > 0,
    prefill: (text: string) => {
      setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    },
  }), [input, images, textAttachments]);
 
  /**
   * Paste handling has two independent jobs.
   *
   * An image on the clipboard is read into an image attachment when the model
   * can see images. Text is separate: past `pasteThreshold` characters it
   * becomes a text attachment chip instead of landing in the textarea, so a
   * pasted document does not bury the question the user is still writing. The
   * content still reaches the model — it travels as its own text part.
   *
   * The two never both fire for one event: an image paste carries no meaningful
   * `text/plain` payload, and once an image is consumed the default is already
   * prevented.
   */
  const handlePaste = (e: React.ClipboardEvent) => {
    let handledImage = false;
    if (isVisionModel) {
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          handledImage = true;
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
              const base64 = ev.target?.result as string;
              setImages((prev) => [...prev, base64]);
            };
            reader.readAsDataURL(file);
          }
        }
      }
    }
    if (handledImage) return;

    const text = e.clipboardData.getData('text/plain');
    if (!shouldAttachPaste(text, pasteThreshold)) return;
    e.preventDefault();
    setTextAttachments((prev) => [
      ...prev,
      createTextAttachment(text, 'text/plain', { label: t('sidebar.pastedAttachment') }),
    ]);
  };
 
  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };
 
  const removeTextAttachment = (id: string) => {
    setTextAttachments((prev) => prev.filter((a) => a.id !== id));
  };
 
  const handleSend = () => {
    if ((!input.trim() && images.length === 0 && textAttachments.length === 0) || isStreaming) return;
    onSend(input.trim(), images, textAttachments);
    setInput('');
    setImages([]);
    setTextAttachments([]);
  };
 
  /**
   * Send key behavior follows the `sendKey` UI setting:
   * - `'enter'`: Enter (no modifier) sends; any modifier+Enter inserts a newline.
   * - `'meta-enter'`: any modifier+Enter sends (Ctrl/Alt/Shift on Windows,
   *   ⌘/⌥/⇧ on macOS); plain Enter inserts a newline.
   *
   * FIX: Ignore Enter while an IME (input method) is composing.
   * - e.nativeEvent.isComposing === true  -> IME composition is in progress
   * - e.nativeEvent.keyCode === 229       -> legacy browsers that don't expose isComposing
   *
   * When composing, the Enter key is used to confirm/commit the candidate word and
   * should ONLY commit the composition to the input, not trigger a send.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Skip if the event originates from an IME composition session
    const nativeEvent = e.nativeEvent;
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }

    if (e.key !== 'Enter') return;

    const hasModifier = e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;

    if (sendKey === 'enter') {
      // Enter sends; any modifier+Enter inserts a newline.
      // We must explicitly insert \n at cursor for Ctrl/Alt+Enter since the
      // browser default only guarantees a newline for Shift+Enter.
      if (hasModifier) {
        e.preventDefault();
        const el = textareaRef.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const newValue = input.slice(0, start) + '\n' + input.slice(end);
        // Direct DOM mutation first so the browser applies native scroll to cursor.
        el.value = newValue;
        el.selectionStart = el.selectionEnd = start + 1;
        // Sync React state so it stays in control.
        setInput(newValue);
        // Programmatic value assignment doesn't trigger native auto-scroll,
        // so we manually scroll to keep the cursor visible.
        const cursorRatio = (start + 1) / newValue.length;
        el.scrollTop = cursorRatio * (el.scrollHeight - el.clientHeight);
        return;
      }
      e.preventDefault();
      handleSend();
      return;
    }

    // meta-enter mode: any modifier+Enter sends; plain Enter inserts a newline.
    if (!hasModifier) return;
    e.preventDefault();
    handleSend();
  };
 
  const handleImageUpload = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) {
        Array.from(files).forEach((file) => {
          const reader = new FileReader();
          reader.onload = (ev) => {
            setImages((prev) => [...prev, ev.target?.result as string]);
          };
          reader.readAsDataURL(file);
        });
      }
    };
    inp.click();
  };
 
  const hasAttachments = images.length > 0 || textAttachments.length > 0;
 
  // ─── Internal drag-and-drop (from within the sidebar) ────────────────────
  const handleInputDragEnter = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    internalDragCounterRef.current += 1;
    if (internalDragCounterRef.current === 1) {
      setIsInternalDragOver(true);
    }
  }, [isInternalDrag]);
 
  const handleInputDragLeave = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    internalDragCounterRef.current -= 1;
    if (internalDragCounterRef.current === 0) {
      setIsInternalDragOver(false);
    }
  }, [isInternalDrag]);
 
  const handleInputDragOver = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, [isInternalDrag]);
 
  const handleInputDrop = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    internalDragCounterRef.current = 0;
    setIsInternalDragOver(false);
 
    // Check for image drag (from chat history image attachments) first
    const imageDataUrl = e.dataTransfer.getData(LUMO_IMAGE_DRAG_MIME);
    if (imageDataUrl) {
      if (isVisionModel) {
        setImages((prev) => [...prev, imageDataUrl]);
      }
      return;
    }

    // Check for a full attachment payload next. Any `TextAttachment.kind`
    // (page-context, file-ref, plain text, html, ...) round-trips through this
    // single path with kind/label/mediaType preserved.
    const attachmentJson = e.dataTransfer.getData(LUMO_ATTACHMENT_MIME);
    if (attachmentJson && onInternalAttachmentDrop) {
      try {
        const attachment = JSON.parse(attachmentJson) as TextAttachment;
        if (attachment && typeof attachment.content === 'string') {
          onInternalAttachmentDrop(attachment);
          return;
        }
      } catch {
        // Malformed payload: fall through to the legacy text handling below.
      }
    }

    // Check for file reference next
    const fileName = e.dataTransfer.getData(LUMO_FILE_REF_MIME);
    if (fileName && onInternalFileDrop) {
      onInternalFileDrop(fileName);
      return;
    }

    // Otherwise treat as text drop
    const text = e.dataTransfer.getData('text/plain');
    if (text?.trim() && onInternalTextDrop) {
      onInternalTextDrop(text.trim());
    }
  }, [isInternalDrag, isVisionModel, onInternalFileDrop, onInternalTextDrop, onInternalAttachmentDrop]);
 
  return (
    <div
      className="p-3 shrink-0"
      onDragEnter={handleInputDragEnter}
      onDragLeave={handleInputDragLeave}
      onDragOver={handleInputDragOver}
      onDrop={handleInputDrop}
    >
      <div
        className={`rounded-xl border-2 overflow-hidden transition-all duration-150 focus-within:border-chat-user/50 ${
          isInternalDragOver
            ? 'border-chat-user border-dashed bg-chat-user/15 shadow-[0_0_8px_0_var(--color-chat-user)/20] scale-[1.01]'
            : isInternalDrag
              ? 'border-chat-user/50 border-dashed bg-chat-user/5'
              : 'border-border bg-muted/50 border'
        }`}
      >
        {/* Attachment previews inside the input box */}
        <AnimatePresence>
          {hasAttachments && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3 pt-3 flex gap-2 overflow-x-auto scrollbar-lumo"
            >
              {/* Image attachments */}
              {images.map((img, i) => (
                <div key={`img-${i}`} className="relative shrink-0 group">
                  <img src={img} className="h-14 w-14 object-cover rounded-lg" alt="" />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 bg-foreground/80 text-background rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {/* Text attachments */}
              {textAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative shrink-0 group flex items-center gap-1.5 h-14 px-2.5 rounded-lg bg-muted border border-border max-w-[180px]"
                  title={attachment.preview}
                >
                  {attachment.kind === 'page-context' ? (
                    <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex flex-col overflow-hidden min-w-0">
                    <span className="text-[10px] text-muted-foreground leading-tight">
                      {attachmentLabel(attachment, t)}
                    </span>
                    <span className="text-xs truncate leading-tight">{attachment.preview}</span>
                  </div>
                  <button
                    onClick={() => removeTextAttachment(attachment.id)}
                    className="absolute -top-1.5 -right-1.5 bg-foreground/80 text-background rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
 
        {/* Textarea body */}
        <div className="px-3 pt-3 pb-1">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('sidebar.placeholder')}
            className="min-h-[36px] resize-none overflow-y-auto text-sm border-0 bg-transparent p-0 shadow-none placeholder:text-muted-foreground/60 scrollbar-lumo"
            style={{ maxHeight: MAX_INPUT_HEIGHT }}
            rows={1}
          />
        </div>
 
        {/* Footer toolbar */}
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-0.5">
            {isVisionModel && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={handleImageUpload}
                title={t('sidebar.pasteImage')}
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="flex items-center">
            {isStreaming ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-destructive hover:text-destructive"
                onClick={onStop}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-30"
                onClick={handleSend}
                disabled={!input.trim() && images.length === 0 && textAttachments.length === 0}
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, ImagePlus, X, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { TextAttachment } from '@/types';

export interface ChatInputHandle {
  focus: () => void;
  addImages: (dataUrls: string[]) => void;
  addTextAttachment: (attachment: TextAttachment) => void;
}

interface ChatInputProps {
  isStreaming: boolean;
  isVisionModel: boolean;
  onSend: (input: string, images: string[], textAttachments: TextAttachment[]) => void;
  onStop: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { isStreaming, isVisionModel, onSend, onStop },
  ref,
) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  }));

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!isVisionModel) return;
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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

  return (
    <div className="p-3 shrink-0">
      <div
        className="rounded-xl border border-border bg-muted/50 overflow-hidden transition-colors focus-within:border-chat-user/50"
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
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col overflow-hidden min-w-0">
                    <span className="text-[10px] text-muted-foreground leading-tight">
                      {attachment.mediaType === 'text/html' ? 'HTML' : t('sidebar.textAttachment')}
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
            className="min-h-[36px] max-h-[120px] resize-none text-sm border-0 bg-transparent p-0 shadow-none placeholder:text-muted-foreground/60"
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

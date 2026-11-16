import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

// ─── Conversation ───────────────────────────────────────────────────────────

interface ConversationProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Conversation({ className, children, ...props }: ConversationProps) {
  return (
    <div className={cn('relative flex flex-1 flex-col overflow-hidden', className)} {...props}>
      {children}
    </div>
  );
}

// ─── ConversationContent ────────────────────────────────────────────────────

interface ConversationContentProps extends React.HTMLAttributes<HTMLDivElement> {
  scrollRef?: React.Ref<HTMLElement | null>;
  contentRef?: React.Ref<HTMLElement | null>;
  /**
   * Optional trailing filler, rendered inside the scroll viewport but *outside*
   * the content element. It reserves scroll room without participating in the
   * content's own height — which is what lets a controller resize it from a
   * `ResizeObserver` callback without re-triggering that observer.
   */
  spacerRef?: React.Ref<HTMLDivElement | null>;
}

export function ConversationContent({
  className,
  children,
  scrollRef,
  contentRef,
  spacerRef,
  ...props
}: ConversationContentProps) {
  return (
    <div
      ref={scrollRef as React.Ref<HTMLDivElement>}
      // `stable` reserves the scrollbar track whether or not the transcript
      // overflows, so the first message that makes the list scrollable does not
      // shift every bubble sideways by the scrollbar width.
      className={cn('flex-1 overflow-y-auto scrollbar-lumo [scrollbar-gutter:stable]', className)}
      {...props}
    >
      <div ref={contentRef as React.Ref<HTMLDivElement>} className="flex flex-col gap-4 px-3 py-3">
        {children}
      </div>
      {spacerRef && <div ref={spacerRef} aria-hidden />}
    </div>
  );
}

// ─── ConversationScrollButton ───────────────────────────────────────────────

interface ConversationScrollButtonProps {
  isAtBottom?: boolean;
  scrollToBottom?: () => void;
  className?: string;
}

export function ConversationScrollButton({
  isAtBottom = true,
  scrollToBottom,
  className,
}: ConversationScrollButtonProps) {
  const { t } = useTranslation();
  return (
    <AnimatePresence>
      {!isAtBottom && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          className={cn('absolute bottom-2 left-1/2 -translate-x-1/2 z-10', className)}
        >
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 rounded-full shadow-md bg-background/90 backdrop-blur-sm"
            onClick={scrollToBottom}
            aria-label={t('sidebar.scrollToBottom')}
            title={t('sidebar.scrollToBottom')}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── useConversationScroll hook ─────────────────────────────────────────────
//
// Moved to `components/chat/useChatScroll.ts`: the transcript now picks between
// a bottom-following controller and an anchored one, so this scaffold only owns
// the markup.

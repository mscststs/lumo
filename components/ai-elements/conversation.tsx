import * as React from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
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
}

export function ConversationContent({
  className,
  children,
  scrollRef,
  contentRef,
  ...props
}: ConversationContentProps) {
  return (
    <div
      ref={scrollRef as React.Ref<HTMLDivElement>}
      className={cn('flex-1 overflow-y-auto scrollbar-lumo', className)}
      {...props}
    >
      <div ref={contentRef as React.Ref<HTMLDivElement>} className="flex flex-col gap-4 px-3 py-3">
        {children}
      </div>
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
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── useConversationScroll hook ─────────────────────────────────────────────

export function useConversationScroll() {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
  return { scrollRef, contentRef, isAtBottom, scrollToBottom };
}

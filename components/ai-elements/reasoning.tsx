import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { MessageResponse } from '@/components/ai-elements/message';

/**
 * How long a finished chain of thought stays open before auto-collapsing.
 *
 * Long enough to read the last lines that just streamed in, short enough that
 * the answer the user is waiting for is not held below content they have
 * already watched arrive.
 */
const AUTO_COLLAPSE_DELAY_MS = 1500;

interface ReasoningProps {
  text: string;
  /** Streaming reasoning is auto-expanded so the user sees live progress. */
  isStreaming?: boolean;
  /**
   * Collapse the block once it stops streaming, instead of leaving it expanded
   * for the rest of the message's life. Wired to the `autoCollapseReasoning`
   * UI setting; `false` preserves the previous behaviour.
   */
  autoCollapse?: boolean;
  className?: string;
}

/** Compact, collapsible chain-of-thought block. */
export function Reasoning({
  text,
  isStreaming = false,
  autoCollapse = false,
  className,
}: ReasoningProps) {
  const { t } = useTranslation();
  // Controlled rather than `defaultOpen` so the collapse can be driven by the
  // end of the stream. `isStreaming` is false for a message rendered from
  // history, so a reopened conversation mounts collapsed — as it always did.
  const [open, setOpen] = useState(isStreaming);
  // Held in a ref rather than returned from the effect so a manual expansion
  // can cancel a pending collapse: the trigger is outside the effect, and a
  // block the user just opened by hand must not snap shut under it.
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Reasoning arriving is the one moment it must be visible.
    if (isStreaming) {
      clearCollapseTimer();
      setOpen(true);
      return;
    }
    if (!autoCollapse) {
      clearCollapseTimer();
      return;
    }

    // Runs on the streaming → settled edge, and again if the setting is turned
    // on while a finished block is on screen.
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      setOpen(false);
    }, AUTO_COLLAPSE_DELAY_MS);
    return clearCollapseTimer;
  }, [isStreaming, autoCollapse, clearCollapseTimer]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Opening a settled block is the user asking to read it; keep it open.
      if (next) clearCollapseTimer();
      setOpen(next);
    },
    [clearCollapseTimer],
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className={cn('rounded-lg border border-border/60 bg-muted/25 overflow-hidden w-full min-w-0', className)}
    >
      <CollapsibleTrigger className="group/reasoning gap-1.5 px-2 py-1.5 hover:bg-muted/60 transition-colors min-w-0">
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/reasoning:rotate-90" />
        <Brain
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground',
            isStreaming && 'animate-pulse',
          )}
        />
        <span className="text-[0.6875rem] font-medium text-muted-foreground truncate">
          {isStreaming ? t('sidebar.reasoning.thinking') : t('sidebar.reasoning.title')}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t border-border/60 px-2 py-1.5">
        <div className="text-muted-foreground">
          <MessageResponse isStreaming={isStreaming}>{text}</MessageResponse>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

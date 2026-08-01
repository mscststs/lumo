import { useTranslation } from 'react-i18next';
import { ChevronRight, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { MessageResponse } from '@/components/ai-elements/message';

interface ReasoningProps {
  text: string;
  /** Streaming reasoning is auto-expanded so the user sees live progress. */
  isStreaming?: boolean;
  className?: string;
}

/** Compact, collapsible chain-of-thought block. */
export function Reasoning({ text, isStreaming = false, className }: ReasoningProps) {
  const { t } = useTranslation();

  return (
    <Collapsible
      defaultOpen={isStreaming}
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

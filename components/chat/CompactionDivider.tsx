import { useTranslation } from 'react-i18next';
import { Archive, ChevronRight } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { MessageResponse } from '@/components/ai-elements/message';
import { formatContextTokens } from '@/lib/context-window';
import { cn } from '@/lib/utils';
import type { ConversationCompaction } from '@/types';

interface CompactionDividerProps {
  compaction: ConversationCompaction;
  /** Render as the first row of the transcript rather than between messages. */
  className?: string;
}

/**
 * The seam where older history was folded into a checkpoint.
 *
 * Replaces the compacted range in the *prompt* only — every original message is
 * still stored and still rendered below, so the user can always scroll back to
 * read what the summary compressed. Collapsed by default: the summary is a
 * machine-facing artifact, and the transcript's job is the conversation itself.
 */
export function CompactionDivider({ compaction, className }: CompactionDividerProps) {
  const { t } = useTranslation();

  return (
    <Collapsible className={cn('w-full min-w-0', className)}>
      <CollapsibleTrigger className="group/compaction w-full items-center gap-2 py-0.5">
        <span className="h-px flex-1 bg-border/70" aria-hidden />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-muted/70">
          <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/compaction:rotate-90" />
          <Archive className="h-3 w-3 shrink-0" />
          <span className="truncate">{t('sidebar.compactedHistory')}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground/70">
            {formatContextTokens(compaction.tokensBefore)}
          </span>
        </span>
        <span className="h-px flex-1 bg-border/70" aria-hidden />
      </CollapsibleTrigger>

      <CollapsibleContent className="px-1 pt-1.5">
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground">
          <MessageResponse>{compaction.summary}</MessageResponse>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

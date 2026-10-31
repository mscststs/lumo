import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Info } from 'lucide-react';
import { formatContextTokens } from '@/lib/context-window';
import type { CompactionNotice as CompactionNoticeData } from '@/types';

interface CompactionNoticeProps {
  notice: CompactionNoticeData | null;
}

/**
 * Transient feedback for a compaction that is not otherwise visible.
 *
 * Two cases share this strip because both are informational, not failures:
 * - `nothing-to-compact`: a manual `/compact` found the conversation already
 *   inside its retained budget. It names *why* so the action does not look like
 *   it silently did nothing.
 * - `compacted`: the agent loop folded history between tool steps. Without this
 *   the summary call is invisible and a mid-turn pause reads as a stall.
 *
 * Both fade out on their own rather than becoming permanent chrome.
 */
export function CompactionNotice({ notice }: CompactionNoticeProps) {
  return (
    <AnimatePresence initial={false}>
      {notice && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="px-3 pb-1"
          role="status"
        >
          <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              <NoticeBody notice={notice} />
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function NoticeBody({ notice }: { notice: CompactionNoticeData }) {
  const { t } = useTranslation();

  switch (notice.kind) {
    case 'nothing-to-compact':
      return (
        <>
          {t('sidebar.compactNothing', {
            tokens: formatContextTokens(notice.keepRecentTokens),
          })}
        </>
      );
    case 'compacted':
      return (
        <>
          {t('sidebar.compactedHistory')}
          <span className="ms-1.5 font-mono tabular-nums text-foreground/80">
            {`${formatContextTokens(notice.tokensBefore)} → ${formatContextTokens(notice.tokensAfter)}`}
          </span>
        </>
      );
  }
}

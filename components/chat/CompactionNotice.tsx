import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Info } from 'lucide-react';
import { formatContextTokens } from '@/lib/context-window';
import type { CompactionNotice as CompactionNoticeData } from '@/types';

interface CompactionNoticeProps {
  notice: CompactionNoticeData | null;
}

/**
 * Transient explanation for a manual compaction that had nothing to do.
 *
 * A no-op is not a failure, so it must not wear the error card's clothes. It
 * names *why* — the conversation has not crossed the retained-token budget —
 * which also points at the setting that decides it, and then fades out on its
 * own rather than becoming permanent chrome.
 */
export function CompactionNotice({ notice }: CompactionNoticeProps) {
  const { t } = useTranslation();

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
              {notice.kind === 'nothing-to-compact' &&
                t('sidebar.compactNothing', {
                  tokens: formatContextTokens(notice.keepRecentTokens),
                })}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

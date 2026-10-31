import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompactionNotice } from '@/types';

/** How long a compaction notice stays on screen before fading out. */
const DEFAULT_DURATION_MS = 5000;

/**
 * Transient compaction feedback.
 *
 * Extracted from the streaming hook so the notice's timer and cleanup have one
 * owner. Showing a notice always replaces the previous one, so a long turn that
 * folds twice cannot stack banners.
 */
export function useCompactionNotice(durationMs = DEFAULT_DURATION_MS) {
  const [notice, setNotice] = useState<CompactionNotice | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    clearTimer();
    setNotice(null);
  }, [clearTimer]);

  const show = useCallback(
    (next: CompactionNotice) => {
      clearTimer();
      setNotice(next);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setNotice(null);
      }, durationMs);
    },
    [clearTimer, durationMs],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { notice, show, clear };
}

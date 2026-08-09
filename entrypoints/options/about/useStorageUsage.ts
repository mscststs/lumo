import { useCallback, useEffect, useState } from 'react';
import { useEvent } from '@/lib/event-bus';
import { collectStorageUsage, type StorageUsageReport } from '@/lib/storage-usage';

export interface UseStorageUsageReturn {
  /** `null` until the first collection resolves. */
  report: StorageUsageReport | null;
  loading: boolean;
  /** Re-measure. `silent` keeps the current numbers on screen while it runs. */
  refresh: (silent?: boolean) => Promise<void>;
}

/**
 * Owns the storage usage report for the about page.
 *
 * A hook rather than state in the card so the numbers survive re-renders of the
 * page and can be re-collected from more than one place (the page header's
 * refresh button, and each clear action once it finishes).
 *
 * Collection is not cheap — it walks every conversation record — so it runs on
 * mount and on demand, never on an interval. `files:changed` is the one push
 * signal worth honouring: an agent writing a file while this tab is open would
 * otherwise leave the file row stale, and that event already exists precisely
 * because IndexedDB has no change notification of its own.
 */
export function useStorageUsage(): UseStorageUsageReturn {
  const [report, setReport] = useState<StorageUsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setReport(await collectStorageUsage());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEvent('files:changed', () => {
    void refresh(true);
  });

  return { report, loading, refresh };
}

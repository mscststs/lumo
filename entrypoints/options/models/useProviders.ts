import { useCallback, useEffect, useState } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { pruneStaleModelSelections } from '@/lib/panel-storage';
import { normalizeProvider } from '@/lib/provider-type';
import type { ModelConfig, ProviderConfig } from '@/types';
import { isSameOrder, reconcileOrder } from './reorder';

/**
 * Owns the provider/model list for the options page.
 *
 * Split out of `ModelSettings` so the page component only deals with layout.
 * Three behaviours live here rather than in the UI:
 *
 * 1. **Live sync.** `providers` is watched, so a second options tab or the
 *    sidebar editing the same list keeps every view in step. The previous
 *    implementation read storage once on mount and silently drifted.
 * 2. **Cascading cleanup.** Deleting a provider or model prunes any panel's
 *    `selectedModel` pointing at it, so the sidebar cannot end up referencing
 *    something that no longer exists.
 * 3. **Optimistic writes.** State updates before the `chrome.storage` round
 *    trip so toggles and reorders feel instant; the watch reconciles.
 */

/** `chrome.storage.local`, narrowed to what pruning needs. */
const panelStorageArea = {
  get: (keys: string | string[]) => chrome.storage.local.get(keys),
  set: (items: Record<string, unknown>) => chrome.storage.local.set(items),
  remove: (keys: string | string[]) => chrome.storage.local.remove(keys),
};

export interface UseProvidersReturn {
  providers: ProviderConfig[];
  /** False until the first read resolves, so the UI can skip a flash of empty state. */
  loading: boolean;
  /** Inserts by id if absent, otherwise replaces in place. */
  upsertProvider: (provider: ProviderConfig) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  upsertModel: (providerId: string, model: ModelConfig) => Promise<void>;
  deleteModel: (providerId: string, modelId: string) => Promise<void>;
  /** Moves a provider by `delta` slots, clamped to the list bounds. */
  moveProvider: (providerId: string, delta: number) => Promise<void>;
  /**
   * Persists a new model order for one provider.
   *
   * Takes the whole list because that is what a drag produces; the caller is
   * responsible for having already reflected it optimistically on screen.
   */
  reorderModels: (providerId: string, models: ModelConfig[]) => Promise<void>;
}

export function useProviders(): UseProvidersReturn {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    storage.getProviders().then((loaded) => {
      if (cancelled) return;
      setProviders(loaded);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Another context (second options tab, sidebar) may rewrite the list.
  useStorageWatch<ProviderConfig[]>(
    'providers',
    useCallback((newValue) => {
      // `normalize` only runs inside `storage.getProviders`, so apply the same
      // legacy-type migration to values arriving from the change event.
      setProviders((newValue ?? []).map(normalizeProvider));
    }, []),
  );

  /**
   * Persists a new list.
   *
   * Reads the current value back from storage first so a concurrent write from
   * another context is not clobbered by this tab's stale copy — the same
   * pattern `storage.upsertConversation` uses.
   */
  const commit = useCallback(
    async (update: (current: ProviderConfig[]) => ProviderConfig[], { prune = false } = {}) => {
      const current = await storage.getProviders();
      const next = update(current);
      setProviders(next);
      await storage.setProviders(next);
      if (prune) await pruneStaleModelSelections(panelStorageArea, next);
    },
    [],
  );

  const upsertProvider = useCallback(
    async (provider: ProviderConfig) => {
      await commit((current) => {
        const idx = current.findIndex((p) => p.id === provider.id);
        if (idx < 0) return [...current, provider];
        const next = [...current];
        next[idx] = provider;
        return next;
      });
    },
    [commit],
  );

  const deleteProvider = useCallback(
    async (providerId: string) => {
      await commit((current) => current.filter((p) => p.id !== providerId), { prune: true });
    },
    [commit],
  );

  const upsertModel = useCallback(
    async (providerId: string, model: ModelConfig) => {
      await commit((current) =>
        current.map((p) => {
          if (p.id !== providerId) return p;
          const idx = p.models.findIndex((m) => m.id === model.id);
          if (idx < 0) return { ...p, models: [...p.models, model] };
          const models = [...p.models];
          models[idx] = model;
          return { ...p, models };
        }),
      );
    },
    [commit],
  );

  const deleteModel = useCallback(
    async (providerId: string, modelId: string) => {
      await commit(
        (current) =>
          current.map((p) =>
            p.id === providerId ? { ...p, models: p.models.filter((m) => m.id !== modelId) } : p,
          ),
        { prune: true },
      );
    },
    [commit],
  );

  const moveProvider = useCallback(
    async (providerId: string, delta: number) => {
      await commit((current) => {
        const from = current.findIndex((p) => p.id === providerId);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= current.length) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return next;
      });
    },
    [commit],
  );

  const reorderModels = useCallback(
    async (providerId: string, models: ModelConfig[]) => {
      await commit((current) =>
        current.map((p) => {
          if (p.id !== providerId) return p;
          // Reconcile against the freshly-read list: a drag operates on the
          // array that was rendered, which can be stale if another context
          // renamed or removed a model while the pointer was down.
          const reconciled = reconcileOrder(models, p.models);
          return isSameOrder(reconciled, p.models) ? p : { ...p, models: reconciled };
        }),
      );
    },
    [commit],
  );

  return {
    providers,
    loading,
    upsertProvider,
    deleteProvider,
    upsertModel,
    deleteModel,
    moveProvider,
    reorderModels,
  };
}

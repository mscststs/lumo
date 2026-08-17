import { useState, useCallback, useEffect } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatchMultiple } from '@/store/useStorageWatch';
import { panelModelKey, windowModelKey, sessionPanelStorage } from '@/lib/panel-storage';
import { useWindowId } from '@/lib/window-id';
import type { ProviderConfig, ModelConfig } from '@/types';

export interface ModelOption {
  value: string;
  label: string;
}

export interface UseModelSelectionReturn {
  providers: ProviderConfig[];
  selectedProviderId: string;
  selectedModelId: string;
  currentModelValue: string;
  allModels: ModelOption[];
  /**
   * Whether the initial read of providers and the panel's saved model has
   * finished. Until it has, `getSelectedProvider()` returns `undefined` simply
   * because nothing has loaded yet — which is indistinguishable from "no models
   * configured" without this flag. Callers that act on their own schedule
   * (rather than in response to a click) must wait for it.
   */
  isLoaded: boolean;
  getSelectedProvider: () => ProviderConfig | undefined;
  getSelectedModel: () => ModelConfig | undefined;
  isVisionModel: () => boolean;
  handleModelChange: (value: string) => Promise<void>;
  loadData: () => Promise<void>;
}

interface UseModelSelectionOptions {
  /**
   * Panel identifier. 0 = rightmost (primary), 1 = second from right, etc.
   * Each panel persists its model selection independently.
   */
  panelId?: number;
}

/**
 * Hook that manages provider/model selection state and persistence.
 *
 * ## Window isolation
 *
 * Each window maintains its own model selection in `chrome.storage.session`,
 * keyed by `w${windowId}_selectedModel_${slot}`. This prevents switching a model
 * in one window from affecting another.
 *
 * On every change, the selection is also written back to `chrome.storage.local`
 * under the canonical key (`selectedModel` / `selectedModel_N`), so a newly
 * opened window inherits the most recent choice as its default.
 *
 * On initialization:
 * 1. Try to read from session storage (this window's key) — handles side panel
 *    re-open within the same browser session.
 * 2. Fall back to the local default — handles a brand new window.
 */
export function useModelSelection(options?: UseModelSelectionOptions): UseModelSelectionReturn {
  const panelId = options?.panelId ?? 0;
  const windowId = useWindowId();
  const localKey = panelModelKey(panelId);

  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [isLoaded, setIsLoaded] = useState(false);

  // Watch for provider changes from options page (applies to all panels/windows)
  useStorageWatchMultiple(
    ['providers'],
    useCallback((key, newValue) => {
      if (key === 'providers') {
        const newProviders = (newValue as ProviderConfig[] | undefined) || [];
        setProviders(newProviders);
      }
    }, []),
  );

  // Watch for model selection changes for THIS window+panel's session key
  useEffect(() => {
    if (windowId == null) return;
    const sessionKey = windowModelKey(windowId, panelId);

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      if (sessionKey in changes) {
        const model = changes[sessionKey]?.newValue as { providerId: string; modelId: string } | null | undefined;
        if (model) {
          setSelectedProviderId(model.providerId);
          setSelectedModelId(model.modelId);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [windowId, panelId]);

  const loadData = useCallback(async () => {
    try {
      const provs = await storage.getProviders();
      setProviders(provs);

      type ModelSelection = { providerId: string; modelId: string } | null | undefined;
      let selectedModel: ModelSelection = null;

      // 1. Try session storage (window-scoped) if windowId is available
      if (windowId != null) {
        const sessionKey = windowModelKey(windowId, panelId);
        const sessionResult = await chrome.storage.session.get(sessionKey);
        selectedModel = sessionResult[sessionKey] as ModelSelection;
      }

      // 2. Fall back to local storage (global default)
      if (!selectedModel) {
        const localResult = await chrome.storage.local.get(localKey);
        selectedModel = localResult[localKey] as ModelSelection;
      }

      if (selectedModel) {
        setSelectedProviderId(selectedModel.providerId);
        setSelectedModelId(selectedModel.modelId);
      } else if (provs.length > 0) {
        const firstProvider = provs[0]!;
        if (firstProvider.models.length > 0) {
          setSelectedProviderId(firstProvider.id);
          setSelectedModelId(firstProvider.models[0]!.id);
        }
      }
    } finally {
      setIsLoaded(true);
    }
  }, [windowId, panelId, localKey]);

  const getSelectedProvider = useCallback((): ProviderConfig | undefined => {
    return providers.find((p) => p.id === selectedProviderId);
  }, [providers, selectedProviderId]);

  const getSelectedModel = useCallback((): ModelConfig | undefined => {
    const provider = providers.find((p) => p.id === selectedProviderId);
    return provider?.models.find((m) => m.id === selectedModelId);
  }, [providers, selectedProviderId, selectedModelId]);

  const isVisionModel = useCallback((): boolean => {
    return getSelectedModel()?.isVision ?? false;
  }, [getSelectedModel]);

  const handleModelChange = useCallback(async (value: string) => {
    // value format: providerId::modelId
    const parts = value.split('::');
    const providerId = parts[0] ?? '';
    const modelId = parts[1] ?? '';
    setSelectedProviderId(providerId);
    setSelectedModelId(modelId);

    const selection = { providerId, modelId };

    // Write to session storage (window-scoped) if windowId is known
    if (windowId != null) {
      const sessionKey = windowModelKey(windowId, panelId);
      await sessionPanelStorage.set({ [sessionKey]: selection });
    }

    // Always write back to local as the global default for new windows
    await chrome.storage.local.set({ [localKey]: selection });
  }, [windowId, panelId, localKey]);

  const allModels: ModelOption[] = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}::${m.id}`,
      label: m.displayName,
    })),
  );

  const currentModelValue =
    selectedProviderId && selectedModelId ? `${selectedProviderId}::${selectedModelId}` : '';

  return {
    providers,
    selectedProviderId,
    selectedModelId,
    currentModelValue,
    allModels,
    isLoaded,
    getSelectedProvider,
    getSelectedModel,
    isVisionModel,
    handleModelChange,
    loadData,
  };
}

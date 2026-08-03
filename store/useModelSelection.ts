import { useState, useCallback, useEffect } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatchMultiple } from '@/store/useStorageWatch';
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
  getSelectedProvider: () => ProviderConfig | undefined;
  getSelectedModel: () => ModelConfig | undefined;
  isVisionModel: () => boolean;
  handleModelChange: (value: string) => Promise<void>;
  loadData: () => Promise<void>;
}

/**
 * Returns the chrome.storage.local key used to persist the selected model
 * for a given panel. Panel 0 (the rightmost / primary panel) uses the
 * canonical `selectedModel` key for backward compatibility. Secondary
 * panels use `selectedModel_1`, `selectedModel_2`, etc.
 */
function getSelectedModelStorageKey(panelId: number): string {
  return panelId === 0 ? 'selectedModel' : `selectedModel_${panelId}`;
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
 * Each panel (identified by panelId) persists its model choice independently.
 * Panel 0 uses the canonical `selectedModel` key for backward compatibility;
 * panels 1/2 use `selectedModel_1` / `selectedModel_2`.
 */
export function useModelSelection(options?: UseModelSelectionOptions): UseModelSelectionReturn {
  const panelId = options?.panelId ?? 0;
  const storageKey = getSelectedModelStorageKey(panelId);

  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // Watch for provider changes from options page (applies to all panels)
  useStorageWatchMultiple(
    ['providers'],
    useCallback((key, newValue) => {
      if (key === 'providers') {
        const newProviders = (newValue as ProviderConfig[] | undefined) || [];
        setProviders(newProviders);
      }
    }, []),
  );

  // Watch for model selection changes for THIS panel's storage key
  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (storageKey in changes) {
        const model = changes[storageKey]?.newValue as { providerId: string; modelId: string } | null | undefined;
        if (model) {
          setSelectedProviderId(model.providerId);
          setSelectedModelId(model.modelId);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [storageKey]);

  const loadData = useCallback(async () => {
    const provs = await storage.getProviders();
    setProviders(provs);

    // Load this panel's saved model
    const result = await chrome.storage.local.get(storageKey);
    const selectedModel = result[storageKey] as { providerId: string; modelId: string } | null | undefined;

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
  }, [storageKey]);

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
    // Persist to this panel's own storage key
    await chrome.storage.local.set({ [storageKey]: { providerId, modelId } });
  }, [storageKey]);

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
    getSelectedProvider,
    getSelectedModel,
    isVisionModel,
    handleModelChange,
    loadData,
  };
}

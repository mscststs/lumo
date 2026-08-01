import { useState, useCallback } from 'react';
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
 * Hook that manages provider/model selection state and persistence.
 * Handles loading from storage, watching for external changes, and
 * persisting user selections.
 */
export function useModelSelection(): UseModelSelectionReturn {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // Watch for storage changes from options page (or other contexts)
  useStorageWatchMultiple(
    ['providers', 'selectedModel'],
    useCallback((key, newValue) => {
      if (key === 'providers') {
        const newProviders = (newValue as ProviderConfig[] | undefined) || [];
        setProviders(newProviders);
      } else if (key === 'selectedModel') {
        const model = newValue as { providerId: string; modelId: string } | null | undefined;
        if (model) {
          setSelectedProviderId(model.providerId);
          setSelectedModelId(model.modelId);
        }
      }
    }, []),
  );

  const loadData = useCallback(async () => {
    const [provs, selectedModel] = await Promise.all([
      storage.getProviders(),
      storage.getSelectedModel(),
    ]);
    setProviders(provs);
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
  }, []);

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
    await storage.setSelectedModel({ providerId, modelId });
  }, []);

  const allModels: ModelOption[] = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}::${m.id}`,
      label: `${m.displayName} (${p.name})`,
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

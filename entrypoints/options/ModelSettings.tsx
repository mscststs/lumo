import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import type { ModelConfig, ProviderConfig } from '@/types';
import { normalizeProviderType } from '@/lib/provider-type';
import { SettingsHeader } from './components/SettingsHeader';
import { EmptyProviders } from './models/EmptyProviders';
import { ModelDialog } from './models/ModelDialog';
import { ProviderCard } from './models/ProviderCard';
import { ProviderDialog } from './models/ProviderDialog';
import { useProviders } from './models/useProviders';

/**
 * Models settings page.
 *
 * Composition only: data lives in `useProviders`, validation in
 * `models/validation`, and each row/card/dialog is its own component. The page
 * keeps just the two "which draft is open" flags, because that is view state
 * with no meaning outside this screen.
 */
export function ModelSettings() {
  const { t } = useTranslation();
  const {
    providers,
    loading,
    upsertProvider,
    deleteProvider,
    upsertModel,
    deleteModel,
    moveProvider,
    reorderModels,
  } = useProviders();

  const [providerDraft, setProviderDraft] = useState<ProviderConfig | null>(null);
  const [modelDraft, setModelDraft] = useState<{
    providerId: string;
    model: ModelConfig;
  } | null>(null);

  const handleAddProvider = () => {
    setProviderDraft({
      id: uuidv4(),
      name: '',
      // The Chat protocol is what third-party gateways actually serve, so it is
      // the safe default (see `lib/provider-type`).
      type: 'openai-chat',
      baseUrl: '',
      apiKey: '',
      models: [],
    });
  };

  const handleAddModel = (providerId: string) => {
    setModelDraft({
      providerId,
      model: { id: uuidv4(), modelId: '', displayName: '', isVision: false },
    });
  };

  const draftProvider = modelDraft
    ? providers.find((p) => p.id === modelDraft.providerId)
    : undefined;

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.models.title')}
        description={t('options.models.description')}
        actions={
          // Hidden while empty so the empty state owns the single call to
          // action rather than offering the same button twice.
          providers.length > 0 && (
            <Button size="sm" onClick={handleAddProvider} className="gap-1.5">
              <Plus className="h-4 w-4" />
              {t('options.models.addProvider')}
            </Button>
          )
        }
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span>{t('common.loading')}</span>
        </div>
      ) : providers.length === 0 ? (
        <EmptyProviders onAddProvider={handleAddProvider} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {providers.map((provider, index) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isFirst={index === 0}
              isLast={index === providers.length - 1}
              onEdit={() => setProviderDraft({ ...provider })}
              onDelete={() => void deleteProvider(provider.id)}
              onMove={(delta) => void moveProvider(provider.id, delta)}
              onAddModel={() => handleAddModel(provider.id)}
              onEditModel={(model) =>
                setModelDraft({ providerId: provider.id, model: { ...model } })
              }
              onDeleteModel={(modelId) => void deleteModel(provider.id, modelId)}
              onReorderModels={(models) => void reorderModels(provider.id, models)}
            />
          ))}
        </div>
      )}

      <ProviderDialog
        draft={providerDraft}
        isExisting={providers.some((p) => p.id === providerDraft?.id)}
        providers={providers}
        onSave={upsertProvider}
        onClose={() => setProviderDraft(null)}
      />

      <ModelDialog
        draft={modelDraft?.model ?? null}
        isExisting={Boolean(
          draftProvider?.models.some((m) => m.id === modelDraft?.model.id),
        )}
        providerName={draftProvider?.name ?? ''}
        // Falls back to the most portable transport while no draft is open: the
        // dialog is unmounted then, so this only picks the list it would render.
        providerType={
          draftProvider ? normalizeProviderType(draftProvider.type) : 'openai-chat'
        }
        siblings={draftProvider?.models ?? []}
        onSave={async (model) => {
          if (modelDraft) await upsertModel(modelDraft.providerId, model);
        }}
        onClose={() => setModelDraft(null)}
      />
    </div>
  );
}

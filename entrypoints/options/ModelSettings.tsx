import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Edit2, ChevronDown, ChevronRight } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { storage } from '@/store/storage';
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_I18N_KEY,
  PROVIDER_BASE_URL_PLACEHOLDER,
} from '@/lib/provider-type';
import type { ProviderConfig, ModelConfig, ProviderType } from '@/types';

export function ModelSettings() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [editingModel, setEditingModel] = useState<{ providerId: string; model: ModelConfig } | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  useEffect(() => {
    storage.getProviders().then(setProviders);
  }, []);

  const saveProviders = async (newProviders: ProviderConfig[]) => {
    setProviders(newProviders);
    await storage.setProviders(newProviders);
  };

  const handleAddProvider = () => {
    setEditingProvider({
      id: uuidv4(),
      name: '',
      type: 'openai-chat',
      baseUrl: '',
      apiKey: '',
      models: [],
    });
  };

  const handleSaveProvider = async () => {
    if (!editingProvider || !editingProvider.name || !editingProvider.apiKey) return;
    const idx = providers.findIndex((p) => p.id === editingProvider.id);
    let newProviders: ProviderConfig[];
    if (idx >= 0) {
      newProviders = [...providers];
      newProviders[idx] = editingProvider;
    } else {
      newProviders = [...providers, editingProvider];
    }
    await saveProviders(newProviders);
    setEditingProvider(null);
    setExpandedProviders((prev) => new Set([...prev, editingProvider.id]));
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm(t('options.models.deleteConfirm'))) return;
    const newProviders = providers.filter((p) => p.id !== id);
    await saveProviders(newProviders);
  };

  const handleAddModel = (providerId: string) => {
    setEditingModel({
      providerId,
      model: {
        id: uuidv4(),
        modelId: '',
        displayName: '',
        isVision: false,
      },
    });
  };

  const handleSaveModel = async () => {
    if (!editingModel || !editingModel.model.modelId || !editingModel.model.displayName) return;
    const newProviders = providers.map((p) => {
      if (p.id !== editingModel.providerId) return p;
      const modelIdx = p.models.findIndex((m) => m.id === editingModel.model.id);
      if (modelIdx >= 0) {
        const newModels = [...p.models];
        newModels[modelIdx] = editingModel.model;
        return { ...p, models: newModels };
      }
      return { ...p, models: [...p.models, editingModel.model] };
    });
    await saveProviders(newProviders);
    setEditingModel(null);
  };

  const handleDeleteModel = async (providerId: string, modelId: string) => {
    if (!confirm(t('options.models.deleteConfirm'))) return;
    const newProviders = providers.map((p) => {
      if (p.id !== providerId) return p;
      return { ...p, models: p.models.filter((m) => m.id !== modelId) };
    });
    await saveProviders(newProviders);
  };

  const toggleExpanded = (id: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground">{t('options.models.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('options.models.description')}</p>
      </div>

      {providers.length === 0 && !editingProvider && (
        <p className="text-muted-foreground text-sm mb-4">{t('options.models.noProviders')}</p>
      )}

      <div className="space-y-3 mb-4">
        {providers.map((provider) => (
          <div key={provider.id} className="border border-border rounded-lg overflow-hidden">
            <div
              className="flex items-center gap-2 p-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => toggleExpanded(provider.id)}
            >
              {expandedProviders.has(provider.id) ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              <span className="font-medium text-sm flex-1 truncate">{provider.name}</span>
              <span className="text-xs text-muted-foreground shrink-0 truncate max-w-[140px] hidden sm:inline">
                {t(`options.models.providerTypes.${PROVIDER_TYPE_I18N_KEY[provider.type]}.label`)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingProvider({ ...provider });
                }}
              >
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteProvider(provider.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <AnimatePresence>
              {expandedProviders.has(provider.id) && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 pt-0 space-y-2">
                    {provider.models.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center gap-2 p-2 rounded-md bg-muted/50"
                      >
                        <span className="text-sm flex-1 truncate">{model.displayName}</span>
                        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                          {model.modelId}
                        </span>
                        {model.isVision && (
                          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">
                            Vision
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() =>
                            setEditingModel({ providerId: provider.id, model: { ...model } })
                          }
                        >
                          <Edit2 className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-destructive"
                          onClick={() => handleDeleteModel(provider.id, model.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => handleAddModel(provider.id)}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      {t('options.models.addModel')}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      <Button onClick={handleAddProvider} className="mb-6">
        <Plus className="h-4 w-4 mr-2" />
        {t('options.models.addProvider')}
      </Button>

      {/* Provider Edit Dialog */}
      <AnimatePresence>
        {editingProvider && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => setEditingProvider(null)}
          >
            <div
              className="bg-card border border-border rounded-lg p-6 w-full max-w-md m-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-4">
                {providers.find((p) => p.id === editingProvider.id)
                  ? t('options.models.editProvider')
                  : t('options.models.addProvider')}
              </h3>
              <div className="space-y-4">
                <div>
                  <Label>{t('options.models.providerName')}</Label>
                  <Input
                    value={editingProvider.name}
                    onChange={(e) =>
                      setEditingProvider({ ...editingProvider, name: e.target.value })
                    }
                    placeholder="My Provider"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>{t('options.models.providerType')}</Label>
                  <Select
                    value={editingProvider.type}
                    onValueChange={(val) =>
                      setEditingProvider({ ...editingProvider, type: val as ProviderType })
                    }
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`options.models.providerTypes.${PROVIDER_TYPE_I18N_KEY[type]}.label`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* The two OpenAI variants hit different endpoints, so spell
                      out which one a given gateway actually serves. */}
                  <p className="text-xs text-muted-foreground mt-1.5 break-words">
                    {t(
                      `options.models.providerTypes.${PROVIDER_TYPE_I18N_KEY[editingProvider.type]}.hint`,
                    )}
                  </p>
                </div>
                <div>
                  <Label>{t('options.models.baseUrl')}</Label>
                  <Input
                    value={editingProvider.baseUrl || ''}
                    onChange={(e) =>
                      setEditingProvider({ ...editingProvider, baseUrl: e.target.value })
                    }
                    placeholder={PROVIDER_BASE_URL_PLACEHOLDER[editingProvider.type]}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>{t('options.models.apiKey')}</Label>
                  <Input
                    type="password"
                    value={editingProvider.apiKey}
                    onChange={(e) =>
                      setEditingProvider({ ...editingProvider, apiKey: e.target.value })
                    }
                    placeholder="sk-..."
                    className="mt-1"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <Button variant="outline" onClick={() => setEditingProvider(null)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleSaveProvider}>{t('common.save')}</Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Model Edit Dialog */}
      <AnimatePresence>
        {editingModel && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => setEditingModel(null)}
          >
            <div
              className="bg-card border border-border rounded-lg p-6 w-full max-w-md m-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-4">
                {providers
                  .find((p) => p.id === editingModel.providerId)
                  ?.models.find((m) => m.id === editingModel.model.id)
                  ? t('options.models.editModel')
                  : t('options.models.addModel')}
              </h3>
              <div className="space-y-4">
                <div>
                  <Label>{t('options.models.modelId')}</Label>
                  <Input
                    value={editingModel.model.modelId}
                    onChange={(e) =>
                      setEditingModel({
                        ...editingModel,
                        model: { ...editingModel.model, modelId: e.target.value },
                      })
                    }
                    placeholder="gpt-4o / claude-sonnet-4-20250514"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>{t('options.models.modelName')}</Label>
                  <Input
                    value={editingModel.model.displayName}
                    onChange={(e) =>
                      setEditingModel({
                        ...editingModel,
                        model: { ...editingModel.model, displayName: e.target.value },
                      })
                    }
                    placeholder="GPT-4o / Claude Sonnet"
                    className="mt-1"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>{t('options.models.isVision')}</Label>
                    <p className="text-xs text-muted-foreground">{t('options.models.isVisionDesc')}</p>
                  </div>
                  <Switch
                    checked={editingModel.model.isVision}
                    onCheckedChange={(checked) =>
                      setEditingModel({
                        ...editingModel,
                        model: { ...editingModel.model, isVision: checked },
                      })
                    }
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <Button variant="outline" onClick={() => setEditingModel(null)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleSaveModel}>{t('common.save')}</Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

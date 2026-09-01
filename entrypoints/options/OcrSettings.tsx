import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { SettingsHeader } from './components/SettingsHeader';
import { SettingRow } from './components/SettingRow';
import type { OcrSettings, ProviderConfig } from '@/types';
import { DEFAULT_OCR_PROMPT } from '@/types';

export function OcrSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<OcrSettings | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  useEffect(() => {
    Promise.all([storage.getOcrSettings(), storage.getProviders()]).then(
      ([ocr, provs]) => {
        setSettings(ocr);
        setProviders(provs);
      },
    );
  }, []);

  // Watch for provider changes from other tabs
  useStorageWatch<ProviderConfig[]>('providers', (newVal) => {
    if (newVal) setProviders(newVal);
  });

  /** All vision-capable models grouped by provider. */
  const visionModels = useMemo(() => {
    return providers
      .map((p) => ({
        provider: p,
        models: p.models.filter((m) => m.isVision),
      }))
      .filter((g) => g.models.length > 0);
  }, [providers]);

  const hasVisionModels = visionModels.length > 0;

  const persist = async (next: OcrSettings) => {
    setSettings(next);
    await storage.setOcrSettings(next);
  };

  const handleToggle = (enabled: boolean) => {
    if (!settings) return;
    void persist({ ...settings, enabled });
  };

  const handleProviderModelChange = (value: string) => {
    if (!settings) return;
    const [providerId, modelId] = value.split('::');
    if (!providerId || !modelId) return;
    void persist({ ...settings, providerId, modelId });
  };

  const handlePromptChange = (prompt: string) => {
    if (!settings) return;
    void persist({ ...settings, prompt });
  };

  const handleResetPrompt = () => {
    if (!settings) return;
    void persist({ ...settings, prompt: DEFAULT_OCR_PROMPT });
  };

  if (!settings) return null;

  const currentValue =
    settings.providerId && settings.modelId
      ? `${settings.providerId}::${settings.modelId}`
      : '';

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.ocr.title')}
        description={t('options.ocr.description')}
      />

      <div className="space-y-5">
        <SettingRow
          label={t('options.ocr.enabled')}
          description={t('options.ocr.enabledDesc')}
        >
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleToggle}
            className="shrink-0"
          />
        </SettingRow>

        {!hasVisionModels && settings.enabled && (
          <p className="text-xs text-destructive">
            {t('options.ocr.noVisionModels')}
          </p>
        )}

        {hasVisionModels && (
          <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
            <Label className="text-sm">{t('options.ocr.model')}</Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
              {t('options.ocr.modelHint')}
            </p>
            <Select
              value={currentValue}
              onValueChange={handleProviderModelChange}
              disabled={!settings.enabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('options.ocr.model')} />
              </SelectTrigger>
              <SelectContent>
                {visionModels.map(({ provider, models }) => (
                  <SelectGroup key={provider.id}>
                    <SelectLabel>{provider.name}</SelectLabel>
                    {models.map((m) => (
                      <SelectItem
                        key={`${provider.id}::${m.id}`}
                        value={`${provider.id}::${m.id}`}
                      >
                        {m.displayName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
          <Label className="text-sm">{t('options.ocr.prompt')}</Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
            {t('options.ocr.promptDesc')}
          </p>
          <Textarea
            value={settings.prompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            disabled={!settings.enabled}
            spellCheck={false}
            className="min-h-[120px] font-mono text-xs leading-relaxed resize-y"
          />
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetPrompt}
              disabled={!settings.enabled || settings.prompt === DEFAULT_OCR_PROMPT}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              {t('options.ocr.resetPrompt')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

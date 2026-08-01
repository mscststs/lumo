import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { storage } from '@/store/storage';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/system-prompt';
import type { SystemPromptSettings } from '@/types';

export function SystemPromptSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SystemPromptSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    storage.getSystemPrompt().then((loaded) => {
      setSettings(loaded);
      setDraft(loaded.prompt);
    });
  }, []);

  const isDirty = useMemo(
    () => settings !== null && draft !== settings.prompt,
    [draft, settings],
  );
  const isDefault = draft.trim() === DEFAULT_SYSTEM_PROMPT.trim();

  /** Persist immediately; `enabled` is a toggle so it should not need a Save. */
  const persist = useCallback(async (next: SystemPromptSettings) => {
    setSettings(next);
    await storage.setSystemPrompt(next);
  }, []);

  const handleToggle = (enabled: boolean) => {
    if (!settings) return;
    void persist({ ...settings, enabled });
  };

  const handleSave = async () => {
    if (!settings) return;
    await persist({ ...settings, prompt: draft });
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 2000);
  };

  const handleReset = () => setDraft(DEFAULT_SYSTEM_PROMPT);

  const handleRevert = () => {
    if (settings) setDraft(settings.prompt);
  };

  if (!settings) return null;

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground">
          {t('options.systemPrompt.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('options.systemPrompt.description')}
        </p>
      </div>

      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-sm">{t('options.systemPrompt.enabled')}</Label>
            <p className="text-xs text-muted-foreground mt-1 break-words">
              {t('options.systemPrompt.enabledDesc')}
            </p>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleToggle}
            className="shrink-0 mt-0.5"
          />
        </div>

        <SystemPromptEditor
          value={draft}
          onChange={setDraft}
          disabled={!settings.enabled}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleSave} disabled={!isDirty}>
            {t('common.save')}
          </Button>
          <Button variant="outline" onClick={handleRevert} disabled={!isDirty}>
            {t('options.systemPrompt.revert')}
          </Button>
          <Button variant="ghost" onClick={handleReset} disabled={isDefault}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            {t('options.systemPrompt.reset')}
          </Button>

          <AnimatePresence>
            {justSaved && (
              <motion.span
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-1 text-xs text-muted-foreground"
              >
                <Check className="h-3.5 w-3.5" />
                {t('options.systemPrompt.saved')}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** The prompt text area plus its character counter. */
function SystemPromptEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <Label className="text-sm">{t('options.systemPrompt.prompt')}</Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        placeholder={t('options.systemPrompt.placeholder')}
        className="mt-1.5 min-h-[280px] font-mono text-xs leading-relaxed resize-y"
      />
      <p className="text-xs text-muted-foreground mt-1.5">
        {t('options.systemPrompt.charCount', { count: value.length })}
      </p>
    </div>
  );
}

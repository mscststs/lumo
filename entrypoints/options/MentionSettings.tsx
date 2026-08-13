import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SettingsHeader } from '@/entrypoints/options/components/SettingsHeader';
import { useMentionSettings } from '@/store/useMentions';

/**
 * Options page for @ mention (reference) settings.
 *
 * Three switches:
 * - Master toggle: enables/disables the whole `@` trigger.
 * - Tabs toggle: whether browser tabs appear in the picker.
 * - Files toggle: whether stored files appear in the picker.
 *
 * Follows the same layout language as the Commands page: master switch at the
 * top, sub-toggles in a section below.
 */
export function MentionSettingsPage() {
  const { t } = useTranslation();
  const { settings, isLoaded, setSettings } = useMentionSettings();

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.mentions.title')}
        description={t('options.mentions.description')}
      />

      {/* Master switch */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm">{t('options.mentions.enableMentions')}</Label>
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {t('options.mentions.enableMentionsDesc')}
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
          className="mt-0.5 shrink-0"
          aria-label={t('options.mentions.enableMentions')}
        />
      </div>

      {/* Sub-toggles */}
      <section className="space-y-4">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          {t('options.mentions.sourcesSection')}
        </h3>

        {/* Tabs toggle */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-3">
          <div className="min-w-0">
            <Label className="text-sm">{t('options.mentions.tabs')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('options.mentions.tabsDesc')}
            </p>
          </div>
          <Switch
            checked={settings.tabsEnabled}
            onCheckedChange={(tabsEnabled) => setSettings({ ...settings, tabsEnabled })}
            disabled={!settings.enabled}
            className="shrink-0"
            aria-label={t('options.mentions.tabs')}
          />
        </div>

        {/* Files toggle */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-3">
          <div className="min-w-0">
            <Label className="text-sm">{t('options.mentions.files')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('options.mentions.filesDesc')}
            </p>
          </div>
          <Switch
            checked={settings.filesEnabled}
            onCheckedChange={(filesEnabled) => setSettings({ ...settings, filesEnabled })}
            disabled={!settings.enabled}
            className="shrink-0"
            aria-label={t('options.mentions.files')}
          />
        </div>
      </section>
    </div>
  );
}

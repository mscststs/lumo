import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTheme } from '@/lib/theme';
import { storage } from '@/store/storage';
import type { UISettings } from '@/types';

export function UISettingsPage() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useState<UISettings['language']>('en');

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setLanguage(settings.language);
    });
  }, []);

  const handleLanguageChange = async (val: string) => {
    const lang = val as UISettings['language'];
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, language: lang });
  };

  const handleThemeChange = async (val: string) => {
    await setTheme(val as UISettings['theme']);
  };

  const handleExport = async () => {
    try {
      const config = await storage.exportConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lumo-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        await storage.importConfig(config);
        // Reload settings
        const settings = await storage.getUISettings();
        setLanguage(settings.language);
        await i18n.changeLanguage(settings.language);
        await setTheme(settings.theme);
        alert(t('options.ui.importSuccess'));
      } catch {
        alert(t('options.ui.importError'));
      }
    };
    input.click();
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground">{t('options.ui.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('options.ui.description')}</p>
      </div>

      <div className="space-y-6">
        {/* Language */}
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('options.ui.language')}</Label>
          <Select value={language} onValueChange={handleLanguageChange}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh">中文</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Theme */}
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('options.ui.theme')}</Label>
          <Select value={theme} onValueChange={handleThemeChange}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t('options.ui.themeLight')}</SelectItem>
              <SelectItem value="dark">{t('options.ui.themeDark')}</SelectItem>
              <SelectItem value="system">{t('options.ui.themeSystem')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Import/Export */}
        <div className="border-t border-border pt-6">
          <Label className="text-sm">{t('options.ui.importExport')}</Label>
          <div className="flex gap-3 mt-3">
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              {t('options.ui.exportConfig')}
            </Button>
            <Button variant="outline" onClick={handleImport}>
              <Upload className="h-4 w-4 mr-2" />
              {t('options.ui.importConfig')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

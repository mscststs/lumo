import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft, Download, Upload } from 'lucide-react';
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
import { cn, isMacPlatform } from '@/lib/utils';
import { storage } from '@/store/storage';
import type { SendKey, UISettings } from '@/types';

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-muted px-1 font-mono text-[11px] leading-none text-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

function SendKeyBadge({ value }: { value: SendKey }) {
  const mac = isMacPlatform();
  const enterKey = (
    <Kbd>
      <CornerDownLeft className="h-3 w-3" />
    </Kbd>
  );
  if (value === 'enter') {
    return <span className="flex items-center gap-1">{enterKey}</span>;
  }
  // "Meta" is a loose shorthand: any modifier key triggers send.
  // Show the platform-appropriate modifiers: ⌘/⌥/⇧ on macOS, Ctrl/Alt/⇧ elsewhere.
  const modifiers = mac ? ['⌘', '⌥', '⇧'] : ['Ctrl', 'Alt', '⇧'];
  return (
    <span className="flex items-center gap-1">
      {modifiers.map((m, i) => (
        <span key={m} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">/</span>}
          <Kbd>{m}</Kbd>
        </span>
      ))}
      <span className="text-muted-foreground">+</span>
      {enterKey}
    </span>
  );
}

export function UISettingsPage() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useState<UISettings['language']>('en');
  const [maxSplitPanels, setMaxSplitPanels] = useState<UISettings['maxSplitPanels']>(1);
  const [sendKey, setSendKey] = useState<UISettings['sendKey']>('enter');

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setLanguage(settings.language);
      setMaxSplitPanels(settings.maxSplitPanels ?? 1);
      setSendKey(settings.sendKey ?? 'enter');
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

  const handleMaxSplitPanelsChange = async (val: string) => {
    const panels = Number(val) as UISettings['maxSplitPanels'];
    setMaxSplitPanels(panels);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, maxSplitPanels: panels });
  };

  const handleSendKeyChange = async (val: string) => {
    const key = val as UISettings['sendKey'];
    setSendKey(key);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, sendKey: key });
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
        setMaxSplitPanels(settings.maxSplitPanels ?? 1);
        setSendKey(settings.sendKey ?? 'enter');
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

        {/* Max Split Panels */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="text-sm">{t('options.ui.maxSplitPanels')}</Label>
            <span className="text-xs text-muted-foreground">{t('options.ui.maxSplitPanelsDesc')}</span>
          </div>
          <Select value={String(maxSplitPanels)} onValueChange={handleMaxSplitPanelsChange}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Send Key */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="text-sm">{t('options.ui.sendKey')}</Label>
            <span className="text-xs text-muted-foreground">{t('options.ui.sendKeyDesc')}</span>
          </div>
          <Select value={sendKey} onValueChange={handleSendKeyChange}>
            <SelectTrigger className="w-52" aria-label={t('options.ui.sendKey')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enter">
                <SendKeyBadge value="enter" />
              </SelectItem>
              <SelectItem value="meta-enter">
                <SendKeyBadge value="meta-enter" />
              </SelectItem>
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

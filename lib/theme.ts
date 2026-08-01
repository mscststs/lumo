import { useEffect, useState, useCallback } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { UISettings } from '@/types';

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setTheme(settings.theme);
      applyTheme(settings.theme);
    });
  }, []);

  // Watch for theme changes from other contexts (e.g. options page)
  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (newValue?.theme) {
        setTheme(newValue.theme);
        applyTheme(newValue.theme);
      }
    }, []),
  );

  const updateTheme = async (newTheme: UISettings['theme']) => {
    setTheme(newTheme);
    applyTheme(newTheme);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, theme: newTheme });
  };

  return { theme, setTheme: updateTheme };
}

function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement;
  if (theme === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

export function ThemeInit() {
  useEffect(() => {
    storage.getUISettings().then((settings) => {
      applyTheme(settings.theme);
    });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      storage.getUISettings().then((settings) => {
        if (settings.theme === 'system') {
          applyTheme('system');
        }
      });
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Watch for theme changes from other contexts (e.g. options page)
  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (newValue?.theme) {
        applyTheme(newValue.theme);
      }
    }, []),
  );

  return null;
}

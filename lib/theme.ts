import { useEffect, useState, useCallback } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { ResolvedTheme, Theme, UISettings } from '@/types';
import { DEFAULT_THEME, SYSTEM_DARK_THEME, THEMES, normalizeTheme } from './theme-registry';

export { THEMES, THEME_OPTIONS, DEFAULT_THEME, normalizeTheme } from './theme-registry';

/** Resolve a preference to the palette that should actually be painted. */
function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? SYSTEM_DARK_THEME
    : 'light';
}

/**
 * Paint a theme onto `<html>` via two coordinated channels:
 * - `.dark` class — drives Tailwind's `dark:` variant and the Shiki overrides,
 *   shared by every dark palette.
 * - `data-theme` attribute — selects the specific token block. Dark palettes
 *   layer on top of `.dark` as `.dark[data-theme='…']`, so each one only
 *   restates the tokens it changes.
 */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.classList.toggle('dark', THEMES[resolved].dark);
  root.dataset.theme = resolved;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      const next = normalizeTheme(settings.theme);
      setTheme(next);
      applyTheme(next);
    });
  }, []);

  // Watch for theme changes from other contexts (e.g. options page)
  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (newValue?.theme) {
        const next = normalizeTheme(newValue.theme);
        setTheme(next);
        applyTheme(next);
      }
    }, []),
  );

  const updateTheme = async (newTheme: Theme) => {
    setTheme(newTheme);
    applyTheme(newTheme);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, theme: newTheme });
  };

  return { theme, setTheme: updateTheme };
}

export function ThemeInit() {
  useEffect(() => {
    storage.getUISettings().then((settings) => {
      applyTheme(normalizeTheme(settings.theme));
    });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      storage.getUISettings().then((settings) => {
        if (normalizeTheme(settings.theme) === 'system') {
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
        applyTheme(normalizeTheme(newValue.theme));
      }
    }, []),
  );

  return null;
}

import { useEffect, useState, useCallback } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { ResolvedTheme, Theme, UISettings } from '@/types';
import { DEFAULT_THEME, SYSTEM_DARK_THEME, THEMES, normalizeTheme } from './theme-registry';

export { THEMES, THEME_OPTIONS, DEFAULT_THEME, normalizeTheme } from './theme-registry';

/**
 * `localStorage` key holding the last painted palette, read by
 * `public/theme-preload.js` before first paint.
 *
 * A cache, never the source of truth — that stays `chrome.storage.local`. It
 * exists solely because `chrome.storage` is async and so cannot be consulted
 * before the browser paints; `localStorage` is synchronous and shared across
 * every page on the extension origin. Only ever holds a `ResolvedTheme` (never
 * `'system'`), so the preload script does not have to re-run media queries for
 * a value that was already resolved here.
 */
const MIRROR_KEY = 'lumo:resolved-theme';

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
 *
 * Also refreshes the `localStorage` mirror the preload script reads, so the
 * *next* page load in this palette starts out already correct.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.classList.toggle('dark', THEMES[resolved].dark);
  root.dataset.theme = resolved;

  // Hand the first-paint inline styles back to the stylesheet.
  //
  // `theme-preload.js` writes an inline background and `color-scheme` because in
  // dev builds no stylesheet exists yet at first paint. Inline styles beat any
  // rule, so leaving them would freeze the page on the palette that was mirrored
  // and make every later theme switch a no-op for the canvas. By the time this
  // runs the stylesheet is live and owns both properties, so clearing them is
  // safe — and doing it here (rather than on a timer) means there is no frame in
  // which neither the inline style nor the stylesheet applies.
  if (root.hasAttribute('data-theme-preload')) {
    root.removeAttribute('data-theme-preload');
    root.style.backgroundColor = '';
    root.style.colorScheme = '';
  }

  // Swallowed deliberately: a failed mirror write (quota, disabled storage,
  // partitioned context) costs a flash on the next load and nothing more, so it
  // must not take down the paint that just succeeded.
  try {
    localStorage.setItem(MIRROR_KEY, resolved);
  } catch {
    // no-op
  }
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

/**
 * Keeps the painted theme correct for the lifetime of the page.
 *
 * Does *not* perform the initial paint: `theme-preload.js` paints the mirrored
 * palette before the first frame and `bootstrapPage` paints the authoritative
 * one before React mounts. This component only reacts to change — the OS
 * flipping appearance, or another context editing the setting — so mounting it
 * cannot cause a flash the way the previous read-on-mount effect did.
 *
 * The storage read still happens once, as reconciliation: if the mirror was
 * stale (settings changed while this page was closed) the preload script painted
 * the old palette, and this is what corrects it.
 */
export function ThemeInit() {
  useEffect(() => {
    let cancelled = false;

    storage
      .getUISettings()
      .then((settings) => {
        if (!cancelled) applyTheme(normalizeTheme(settings.theme));
      })
      .catch((error) => {
        console.error('[Lumo] Failed to reconcile theme:', error);
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
    return () => {
      cancelled = true;
      mediaQuery.removeEventListener('change', handler);
    };
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

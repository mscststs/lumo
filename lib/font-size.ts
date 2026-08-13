import { useCallback, useEffect } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { FontSize, UISettings } from '@/types';

export { FONT_SIZE_OPTIONS, DEFAULT_FONT_SIZE, normalizeFontSize } from './font-size-registry';

/**
 * `localStorage` key holding the last applied font size, read by
 * `public/theme-preload.js` before first paint to prevent layout shift.
 *
 * Mirrors the same pattern as the theme mirror in `lib/theme.ts`.
 */
const MIRROR_KEY = 'lumo:font-size';

/**
 * Apply a font-size to `<html>`. All `rem`-based sizing in Tailwind and the
 * streamdown overrides scales automatically.
 *
 * Also refreshes the `localStorage` mirror the preload script reads.
 */
export function applyFontSize(size: FontSize) {
  document.documentElement.style.fontSize = `${size}px`;

  try {
    localStorage.setItem(MIRROR_KEY, String(size));
  } catch {
    // no-op — same as theme mirror
  }
}

/**
 * Keeps the font size in sync for the lifetime of the page.
 *
 * Does *not* perform the initial paint: `theme-preload.js` paints the mirrored
 * value before the first frame and `bootstrapPage` paints the authoritative
 * one before React mounts. This component only reacts to changes from other
 * contexts (e.g. the options page updating the setting while sidepanel is open).
 */
export function FontSizeInit() {
  useEffect(() => {
    let cancelled = false;

    storage
      .getUISettings()
      .then((settings) => {
        if (!cancelled && settings.fontSize) {
          applyFontSize(settings.fontSize);
        }
      })
      .catch((error) => {
        console.error('[Lumo] Failed to reconcile font size:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (newValue?.fontSize) {
        applyFontSize(newValue.fontSize);
      }
    }, []),
  );

  return null;
}

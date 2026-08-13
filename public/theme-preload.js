/**
 * Synchronous first-paint theme painter.
 *
 * Runs from `<head>` before the stylesheet and before any module executes, so
 * the very first frame is already the correct palette instead of flashing white
 * and repainting once React mounts.
 *
 * Why it cannot read the real setting: the source of truth is
 * `chrome.storage.local`, whose API is asynchronous and therefore unusable here
 * — anything awaited happens after the browser has painted. So `lib/theme.ts`
 * mirrors each resolved palette into `localStorage` (same extension origin, so
 * shared by sidepanel / options / preview) purely as a synchronously readable
 * cache. This file only reads that mirror; `chrome.storage.local` stays
 * authoritative and `ThemeInit` corrects the DOM if the two disagree.
 *
 * Why it paints an inline background rather than relying on CSS: in dev builds
 * there is no stylesheet at first paint at all. `globals.css` is imported from
 * `main.tsx`, so Vite injects it as a `<style>` tag at runtime — setting
 * `data-theme` alone would select a token block that does not exist yet, leaving
 * the page white until the module graph loads. That was the original bug's
 * second half, and it hit the options page hardest because it opens as a full
 * tab. The inline style is handed back to the stylesheet by `applyTheme` as soon
 * as React boots, so it never becomes a permanent override.
 *
 * Kept as a plain classic script in `public/` on purpose:
 * - MV3's CSP (`script-src 'self'`) forbids inline scripts.
 * - `type="module"` is implicitly deferred, which would put it after first paint
 *   and defeat the entire point.
 * - Being in `public/` it is copied verbatim, so it cannot import the registry
 *   and the theme table is duplicated. tests/theme.test.ts pins both the palette
 *   list and these colour values to `lib/theme-registry.ts` and `globals.css` so
 *   the two cannot drift silently.
 */
(function () {
  'use strict';

  // Mirrors `lib/theme-registry.ts` + the `--color-background` of each palette
  // in `assets/globals.css`. Asserted against both by tests.
  var THEMES = {
    light: { dark: false, background: '#ffffff' },
    dark: { dark: true, background: '#020817' },
    midnight: { dark: true, background: '#22242a' },
  };
  var STORAGE_KEY = 'lumo:resolved-theme';
  var SYSTEM_DARK_THEME = 'dark';

  var root = document.documentElement;
  var stored = null;

  // Guarded: `localStorage` throws outright when storage is partitioned or
  // disabled by policy. An uncaught throw would abort the script and leave the
  // page with no theme at all.
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    stored = null;
  }

  var name = Object.prototype.hasOwnProperty.call(THEMES, stored) ? stored : null;

  // No usable mirror: first launch, cleared storage, or a value written by a
  // build that knows a palette this one does not. Fall back to the OS
  // preference — the same choice `resolveTheme('system')` makes, and the
  // registry's default preference is `system` anyway.
  if (name === null) {
    name = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? SYSTEM_DARK_THEME
      : 'light';
  }

  var theme = THEMES[name];

  // Both channels `applyTheme` uses: `.dark` drives Tailwind's `dark:` variant
  // and the Shiki overrides, `data-theme` selects the token block.
  if (theme.dark) root.classList.add('dark');
  root.setAttribute('data-theme', name);

  // The part that survives a missing stylesheet. `color-scheme` additionally
  // themes the canvas, native scrollbars and form controls, which no token can
  // reach. Marked so `applyTheme` knows to hand control back to the stylesheet.
  root.style.backgroundColor = theme.background;
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  root.setAttribute('data-theme-preload', '');

  // ─── Font Size ────────────────────────────────────────────────────────────
  // Same mirror pattern: `lib/font-size.ts` writes to localStorage, read here
  // synchronously so the first frame is already at the correct scale.
  var FONT_SIZE_KEY = 'lumo:font-size';
  var DEFAULT_SIZE = 16;
  var VALID_SIZES = [12, 13, 14, 15, 16, 17, 18];
  var rawSize = null;
  try {
    rawSize = localStorage.getItem(FONT_SIZE_KEY);
  } catch (e) {
    rawSize = null;
  }
  var fontSize = rawSize !== null ? Number(rawSize) : DEFAULT_SIZE;
  if (VALID_SIZES.indexOf(fontSize) === -1) fontSize = DEFAULT_SIZE;
  root.style.fontSize = fontSize + 'px';
})();

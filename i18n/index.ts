import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import {
  DEFAULT_LOCALE,
  detectLanguage,
  localeDirection,
  resolveLanguage,
  type LocaleTag,
} from './locales';
import { loadLocaleBundle, type LocaleBundle } from './load-locale';

export {
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  detectLanguage,
  localeDirection,
  matchLocale,
  normalizeLanguage,
  resolveLanguage,
  sortLocalesForPicker,
  type LanguagePreference,
  type LocaleDescriptor,
  type LocaleTag,
} from './locales';

const resources = {
  [DEFAULT_LOCALE]: { translation: en },
};

i18n.use(initReactI18next).init({
  resources,
  // Intentionally the detected tag even though only `en` is loaded at this
  // point: `bootstrapPage()` awaits `applyLanguage()` before React mounts, so
  // the active bundle is in place before the first frame. Starting at `en`
  // instead would make the first `applyLanguage()` a no-op for English users
  // with a stored non-English preference.
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LOCALE,
  // React renders outside Suspense; returning a key while a bundle is loading
  // would flash raw dots across the UI.
  react: { useSuspense: false },
  interpolation: { escapeValue: false },
});

/** Keep `<html lang>` and `<html dir>` in sync with the active language. */
function syncDocumentLang(tag: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = tag;
  document.documentElement.dir = localeDirection(tag);
}

i18n.on('languageChanged', syncDocumentLang);
syncDocumentLang(i18n.language);

const loaded = new Set<string>([DEFAULT_LOCALE]);

async function ensureBundle(tag: LocaleTag): Promise<void> {
  if (loaded.has(tag)) return;
  const bundle: LocaleBundle = await loadLocaleBundle(tag);
  i18n.addResourceBundle(tag, 'translation', bundle, true, true);
  loaded.add(tag);
}

export default i18n;

/**
 * Switch to a stored language preference, if there is a usable one.
 *
 * Takes the value rather than reading storage itself: language and theme live in
 * the same `uiSettings` record, and both are needed before the first paint, so
 * `lib/page-bootstrap.ts` reads that record once and distributes it. Two
 * independent reads on the critical path was the previous shape, and it made the
 * cold-start latency the sum of both round trips.
 *
 * The bundle is awaited *before* `changeLanguage` so i18next never emits a
 * language change that React renders against an empty bundle. i18next's
 * `fallbackLng` would cover that gap, but the UI would visibly swap from English
 * to the chosen language one frame later.
 */
export async function applyLanguage(language: unknown): Promise<void> {
  const tag = resolveLanguage(language);
  try {
    await ensureBundle(tag);
    if (tag !== i18n.language) {
      await i18n.changeLanguage(tag);
    } else {
      // Same tag, but the bundle may have just been added (the initial
      // `detectLanguage()` chosen at init has no bundle yet). Keep the DOM in
      // sync without forcing a redundant languageChanged round trip.
      syncDocumentLang(tag);
    }
  } catch (error) {
    // Keep the default language rather than blocking the render on a bad value.
    console.error('[Lumo] Failed to apply stored language:', error);
  }
}

/** Track language edits made in another context (e.g. the options page). */
export function watchLanguageChanges(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!('uiSettings' in changes)) return;
    const newSettings = changes.uiSettings?.newValue as { language?: unknown } | undefined;
    if (newSettings && 'language' in newSettings) {
      void applyLanguage(newSettings.language);
    }
  });
}

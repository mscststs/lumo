import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { zh } from './zh';

const resources = {
  en: { translation: en },
  zh: { translation: zh },
};

/** Supported concrete languages (everything except 'auto'). */
const SUPPORTED_LANGS = Object.keys(resources);

/**
 * Detect the best concrete language from the browser/OS locale.
 * Returns 'zh' for any Chinese variant, 'en' otherwise.
 */
export function detectLanguage(): 'en' | 'zh' {
  let raw: string = 'en';
  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
    raw = chrome.i18n.getUILanguage();
  } else if (typeof navigator !== 'undefined' && navigator.language) {
    raw = navigator.language;
  }
  const base = (raw.split('-')[0] ?? 'en').toLowerCase();
  return SUPPORTED_LANGS.includes(base) ? (base as 'en' | 'zh') : 'en';
}

/**
 * Resolve the stored language setting to a concrete language code.
 * 'auto' (or any falsy/unrecognised value) triggers browser detection.
 */
export function resolveLanguage(language: string | undefined): 'en' | 'zh' {
  if (language && language !== 'auto' && SUPPORTED_LANGS.includes(language)) {
    return language as 'en' | 'zh';
  }
  return detectLanguage();
}

i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

/** Keep <html lang> in sync with the active language so the browser
 *  never mistakes the UI for a foreign-language page (translate prompt). */
const HTML_LANG: Record<string, string> = { en: 'en', zh: 'zh-CN' };

function syncDocumentLang(lng: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = HTML_LANG[lng] ?? lng;
}

i18n.on('languageChanged', syncDocumentLang);
syncDocumentLang(i18n.language);

export default i18n;

/**
 * Switch to a stored language preference, if there is a usable one.
 *
 * Takes the value rather than reading storage itself: language and theme live in
 * the same `uiSettings` record, and both are needed before the first paint, so
 * `lib/page-bootstrap.ts` reads that record once and distributes it. Two
 * independent reads on the critical path was the previous shape, and it made the
 * cold-start latency the sum of both round trips.
 */
export async function applyLanguage(language: string | undefined): Promise<void> {
  const resolved = resolveLanguage(language);
  if (resolved === i18n.language) return;
  try {
    await i18n.changeLanguage(resolved);
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
    const newSettings = changes.uiSettings?.newValue as { language?: string } | undefined;
    if (newSettings?.language) {
      const resolved = resolveLanguage(newSettings.language);
      if (resolved !== i18n.language) {
        i18n.changeLanguage(resolved);
      }
    }
  });
}

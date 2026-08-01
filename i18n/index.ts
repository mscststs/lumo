import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { zh } from './zh';

const resources = {
  en: { translation: en },
  zh: { translation: zh },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
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

export async function initI18nFromStorage() {
  try {
    const result = await chrome.storage.local.get('uiSettings');
    const uiSettings = result.uiSettings as { language?: string } | undefined;
    if (uiSettings?.language) {
      await i18n.changeLanguage(uiSettings.language);
    }
  } catch {
    // fallback to default
  }

  // Watch for language changes from other contexts (e.g. options page)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if ('uiSettings' in changes) {
      const newSettings = changes.uiSettings?.newValue as { language?: string } | undefined;
      if (newSettings?.language && newSettings.language !== i18n.language) {
        i18n.changeLanguage(newSettings.language);
      }
    }
  });
}

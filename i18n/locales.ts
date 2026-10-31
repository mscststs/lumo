/**
 * The single source of truth for every language Lumo ships.
 *
 * Two different codes exist for the same language, and mixing them up is the
 * classic way an extension ends up with a translated UI but an English store
 * listing:
 *
 * - `tag`    — BCP-47, used by i18next, `Intl.*`, `<html lang>` and storage.
 * - `chrome` — Chrome's `_locales/<code>` directory name. It uses underscores
 *              and cannot express scripts, so `zh-TW` becomes `zh_TW`.
 *
 * Everything else (detection, the settings picker, `dir`, the manifest folders)
 * is derived from this record, so adding a language is one entry plus one
 * `i18n/locales/<tag>.json` file.
 *
 * Deliberately free of i18next/React imports: the background service worker
 * imports it too, and bundling the UI stack there would be wasteful.
 */

export interface LocaleDescriptor {
  /** BCP-47 tag, e.g. `zh-TW`, `pt-BR`, `es-419`. */
  tag: string;
  /** Chrome `_locales` directory name, e.g. `zh_TW`. */
  chrome: string;
  /** The language's own name, shown in the picker. */
  native: string;
  /** English name, shown as a secondary line in the picker. */
  english: string;
  dir: 'ltr' | 'rtl';
}

/**
 * Every locale Chrome localises its UI into, in Chrome's alphabetical order.
 *
 * `en` must come first in spirit rather than position: it is the fallback bundle
 * and the manifest `default_locale`.
 */
export const LOCALES: readonly LocaleDescriptor[] = [
  { tag: 'ar', chrome: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl' },
  { tag: 'am', chrome: 'am', native: 'አማርኛ', english: 'Amharic', dir: 'ltr' },
  { tag: 'bg', chrome: 'bg', native: 'Български', english: 'Bulgarian', dir: 'ltr' },
  { tag: 'bn', chrome: 'bn', native: 'বাংলা', english: 'Bengali', dir: 'ltr' },
  { tag: 'ca', chrome: 'ca', native: 'Català', english: 'Catalan', dir: 'ltr' },
  { tag: 'cs', chrome: 'cs', native: 'Čeština', english: 'Czech', dir: 'ltr' },
  { tag: 'da', chrome: 'da', native: 'Dansk', english: 'Danish', dir: 'ltr' },
  { tag: 'de', chrome: 'de', native: 'Deutsch', english: 'German', dir: 'ltr' },
  { tag: 'el', chrome: 'el', native: 'Ελληνικά', english: 'Greek', dir: 'ltr' },
  { tag: 'en', chrome: 'en', native: 'English', english: 'English', dir: 'ltr' },
  {
    tag: 'en-AU',
    chrome: 'en_AU',
    native: 'English (Australia)',
    english: 'English (Australia)',
    dir: 'ltr',
  },
  {
    tag: 'en-GB',
    chrome: 'en_GB',
    native: 'English (United Kingdom)',
    english: 'English (United Kingdom)',
    dir: 'ltr',
  },
  {
    tag: 'en-US',
    chrome: 'en_US',
    native: 'English (United States)',
    english: 'English (United States)',
    dir: 'ltr',
  },
  { tag: 'es', chrome: 'es', native: 'Español', english: 'Spanish', dir: 'ltr' },
  {
    tag: 'es-419',
    chrome: 'es_419',
    native: 'Español (Latinoamérica)',
    english: 'Spanish (Latin America and the Caribbean)',
    dir: 'ltr',
  },
  { tag: 'et', chrome: 'et', native: 'Eesti', english: 'Estonian', dir: 'ltr' },
  { tag: 'fa', chrome: 'fa', native: 'فارسی', english: 'Persian', dir: 'rtl' },
  { tag: 'fi', chrome: 'fi', native: 'Suomi', english: 'Finnish', dir: 'ltr' },
  { tag: 'fil', chrome: 'fil', native: 'Filipino', english: 'Filipino', dir: 'ltr' },
  { tag: 'fr', chrome: 'fr', native: 'Français', english: 'French', dir: 'ltr' },
  { tag: 'gu', chrome: 'gu', native: 'ગુજરાતી', english: 'Gujarati', dir: 'ltr' },
  { tag: 'he', chrome: 'he', native: 'עברית', english: 'Hebrew', dir: 'rtl' },
  { tag: 'hi', chrome: 'hi', native: 'हिन्दी', english: 'Hindi', dir: 'ltr' },
  { tag: 'hr', chrome: 'hr', native: 'Hrvatski', english: 'Croatian', dir: 'ltr' },
  { tag: 'hu', chrome: 'hu', native: 'Magyar', english: 'Hungarian', dir: 'ltr' },
  { tag: 'id', chrome: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr' },
  { tag: 'it', chrome: 'it', native: 'Italiano', english: 'Italian', dir: 'ltr' },
  { tag: 'ja', chrome: 'ja', native: '日本語', english: 'Japanese', dir: 'ltr' },
  { tag: 'kn', chrome: 'kn', native: 'ಕನ್ನಡ', english: 'Kannada', dir: 'ltr' },
  { tag: 'ko', chrome: 'ko', native: '한국어', english: 'Korean', dir: 'ltr' },
  { tag: 'lt', chrome: 'lt', native: 'Lietuvių', english: 'Lithuanian', dir: 'ltr' },
  { tag: 'lv', chrome: 'lv', native: 'Latviešu', english: 'Latvian', dir: 'ltr' },
  { tag: 'ml', chrome: 'ml', native: 'മലയാളം', english: 'Malayalam', dir: 'ltr' },
  { tag: 'mr', chrome: 'mr', native: 'मराठी', english: 'Marathi', dir: 'ltr' },
  { tag: 'ms', chrome: 'ms', native: 'Bahasa Melayu', english: 'Malay', dir: 'ltr' },
  { tag: 'nl', chrome: 'nl', native: 'Nederlands', english: 'Dutch', dir: 'ltr' },
  { tag: 'no', chrome: 'no', native: 'Norsk bokmål', english: 'Norwegian', dir: 'ltr' },
  { tag: 'pl', chrome: 'pl', native: 'Polski', english: 'Polish', dir: 'ltr' },
  { tag: 'pt-BR', chrome: 'pt_BR', native: 'Português (Brasil)', english: 'Portuguese (Brazil)', dir: 'ltr' },
  { tag: 'pt-PT', chrome: 'pt_PT', native: 'Português (Portugal)', english: 'Portuguese (Portugal)', dir: 'ltr' },
  { tag: 'ro', chrome: 'ro', native: 'Română', english: 'Romanian', dir: 'ltr' },
  { tag: 'ru', chrome: 'ru', native: 'Русский', english: 'Russian', dir: 'ltr' },
  { tag: 'sk', chrome: 'sk', native: 'Slovenčina', english: 'Slovak', dir: 'ltr' },
  { tag: 'sl', chrome: 'sl', native: 'Slovenščina', english: 'Slovenian', dir: 'ltr' },
  { tag: 'sr', chrome: 'sr', native: 'Српски', english: 'Serbian', dir: 'ltr' },
  { tag: 'sv', chrome: 'sv', native: 'Svenska', english: 'Swedish', dir: 'ltr' },
  { tag: 'sw', chrome: 'sw', native: 'Kiswahili', english: 'Swahili', dir: 'ltr' },
  { tag: 'ta', chrome: 'ta', native: 'தமிழ்', english: 'Tamil', dir: 'ltr' },
  { tag: 'te', chrome: 'te', native: 'తెలుగు', english: 'Telugu', dir: 'ltr' },
  { tag: 'th', chrome: 'th', native: 'ไทย', english: 'Thai', dir: 'ltr' },
  { tag: 'tr', chrome: 'tr', native: 'Türkçe', english: 'Turkish', dir: 'ltr' },
  { tag: 'uk', chrome: 'uk', native: 'Українська', english: 'Ukrainian', dir: 'ltr' },
  { tag: 'vi', chrome: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', dir: 'ltr' },
  { tag: 'zh-CN', chrome: 'zh_CN', native: '简体中文', english: 'Chinese (Simplified)', dir: 'ltr' },
  { tag: 'zh-TW', chrome: 'zh_TW', native: '繁體中文', english: 'Chinese (Traditional)', dir: 'ltr' },
];

/** Union of every shipped BCP-47 tag. */
export type LocaleTag = (typeof LOCALES)[number]['tag'];

export const DEFAULT_LOCALE: LocaleTag = 'en';

const BY_LOWER_TAG = new Map<string, LocaleDescriptor>(
  LOCALES.map((locale) => [locale.tag.toLowerCase(), locale])
);

const BY_CHROME = new Map<string, LocaleDescriptor>(
  LOCALES.map((locale) => [locale.chrome.toLowerCase(), locale])
);

/** Look up a locale by BCP-47 tag, case-insensitively. */
export function findLocale(tag: string | undefined | null): LocaleDescriptor | undefined {
  if (!tag) return undefined;
  return BY_LOWER_TAG.get(tag.trim().toLowerCase());
}

/** Look up a locale by Chrome `_locales` directory name. */
export function findLocaleByChromeCode(code: string): LocaleDescriptor | undefined {
  return BY_CHROME.get(code.trim().toLowerCase());
}

/**
 * Languages Chrome may report that are not shipped verbatim. Each maps to the
 * closest shipped bundle, following Chrome's own fallback rules.
 */
const ALIASES: Record<string, LocaleTag> = {
  // Browsers/OSes still emit the pre-ISO codes.
  iw: 'he',
  in: 'id',
  tl: 'fil',
  nb: 'no',
  nn: 'no',
  // Chrome only ships `sr` (Cyrillic); Latin-script Serbian is not a store locale.
  'sr-latn': 'sr',
  'zh-hans': 'zh-CN',
  'zh-hant': 'zh-TW',
};

/** Regions that Chrome reports as `es_419` rather than `es`. */
const LATIN_AMERICA = new Set([
  'ar', 'bo', 'br', 'bz', 'cl', 'co', 'cr', 'cu', 'do', 'ec', 'gt', 'hn',
  'mx', 'ni', 'pa', 'pe', 'pr', 'py', 'sv', 'uy', 've', '419',
]);

/**
 * Resolve any browser/OS locale string to a shipped tag.
 *
 * Order: exact tag → language alias → Chinese script/region → Portuguese
 * variant → Spanish variant → plain language. Anything unknown falls back to
 * English, which is also i18next's fallback bundle.
 */
export function matchLocale(raw: string | undefined | null): LocaleTag {
  if (!raw) return DEFAULT_LOCALE;

  const normalized = raw.trim().replace(/_/g, '-');
  const exact = findLocale(normalized);
  if (exact) return exact.tag as LocaleTag;

  const lower = normalized.toLowerCase();
  const alias = ALIASES[lower];
  if (alias) return alias;

  const [language = '', region = '', ...rest] = lower.split('-');
  const subtags = [region, ...rest].join('-');

  switch (language) {
    case 'zh':
      // `zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant-*`: Traditional. Everything else,
      // including bare `zh`, is Simplified — matching Chrome's own mapping.
      if (
        subtags.includes('hant') ||
        ['tw', 'hk', 'mo'].includes(region)
      ) {
        return 'zh-TW';
      }
      return 'zh-CN';
    case 'pt':
      return region === 'pt' ? 'pt-PT' : 'pt-BR';
    case 'es':
      return LATIN_AMERICA.has(region) ? 'es-419' : 'es';
    case 'en':
      // en-AU / en-GB / en-US are exact matches above; other English regions
      // read the default bundle.
      return 'en';
    case 'fil':
      return 'fil';
    case 'no':
      return 'no';
    default: {
      const base = findLocale(language);
      return base ? (base.tag as LocaleTag) : DEFAULT_LOCALE;
    }
  }
}

/** `'auto' | tag` after storage normalisation. */
export type LanguagePreference = 'auto' | LocaleTag;

const LEGACY_LANGUAGE_VALUES: Record<string, LocaleTag> = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
};

/**
 * Sanitise a stored/imported language value.
 *
 * Configs written before this registry existed stored `'zh'` for Simplified
 * Chinese; anything unrecognised must not reach i18next, where it would pick a
 * non-existent bundle and leave the UI in English with the picker showing a
 * language that is not applied.
 */
export function normalizeLanguage(value: unknown): LanguagePreference {
  if (value === 'auto') return 'auto';
  if (typeof value !== 'string') return 'auto';
  const lower = value.trim().toLowerCase();
  const legacy = LEGACY_LANGUAGE_VALUES[lower];
  if (legacy) return legacy;
  return findLocale(lower)?.tag as LocaleTag | undefined ?? 'auto';
}

/** The tag to actually load for a stored preference. */
export function resolveLanguage(value: unknown): LocaleTag {
  const preference = normalizeLanguage(value);
  return preference === 'auto' ? detectLanguage() : preference;
}

/** Best guess from the browser UI language, falling back to `navigator.language`. */
export function detectLanguage(): LocaleTag {
  let raw: string | undefined;
  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
    raw = chrome.i18n.getUILanguage();
  } else if (typeof navigator !== 'undefined') {
    raw = navigator.languages?.[0] ?? navigator.language;
  }
  return matchLocale(raw);
}

/** Text direction for a tag; unknown tags are LTR. */
export function localeDirection(tag: string): 'ltr' | 'rtl' {
  return findLocale(tag)?.dir ?? 'ltr';
}

/** All tags, in registry order. */
export const LOCALE_TAGS: readonly LocaleTag[] = LOCALES.map(
  (locale) => locale.tag as LocaleTag
);

/**
 * Picker ordering: the active language and English first, then everything else
 * by native name in the *active* language's collation, so a Japanese user sees
 * Japanese names in Japanese dictionary order rather than a Latin approximation.
 */
export function sortLocalesForPicker(activeTag: string): LocaleDescriptor[] {
  const pinnedTags = activeTag === 'en' ? ['en'] : [activeTag, 'en'];
  const pinned = new Set(pinnedTags);
  const collator = new Intl.Collator(activeTag, { sensitivity: 'base' });
  const pinnedLocales = pinnedTags
    .map((tag) => findLocale(tag))
    .filter((locale): locale is LocaleDescriptor => Boolean(locale));
  const rest = LOCALES.filter((locale) => !pinned.has(locale.tag)).sort((a, b) =>
    collator.compare(a.native, b.native)
  );
  return [...pinnedLocales, ...rest];
}

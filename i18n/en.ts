/**
 * Backwards-compatible type/bundle export.
 *
 * Translations now live in `i18n/locales/*.json` so the 55 bundles can be
 * code-split and generated. This module stays as the typed entry point the
 * tests and non-React callers already import.
 */
import en from './locales/en.json';

export { en };
export type TranslationSchema = typeof en;

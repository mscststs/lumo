import { describe, it, expect, beforeAll } from 'vitest';
import i18next from 'i18next';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';

/**
 * Guards the i18n contract the options pages rely on.
 *
 * The plural keys are the fragile part: `modelCount_one` / `modelCount_other`
 * are looked up as `t('options.models.modelCount', { count })`, so a missing
 * suffix or a locale whose plural category differs would render the raw key.
 */

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

const COUNT_KEY = 'options.models.modelCount';

describe('pluralised model count', () => {
  it.each([
    ['en', 1, '1 model'],
    ['en', 0, '0 models'],
    ['en', 5, '5 models'],
    // Chinese has a single plural category; both suffixes carry the same copy so
    // either resolution renders correctly.
    ['zh', 1, '1 个模型'],
    ['zh', 5, '5 个模型'],
  ] as const)('resolves in %s for count=%i', async (lng, count, expected) => {
    await i18next.changeLanguage(lng);
    expect(i18next.t(COUNT_KEY, { count })).toBe(expected);
  });

  it('never falls through to the raw key', async () => {
    for (const lng of ['en', 'zh'] as const) {
      await i18next.changeLanguage(lng);
      for (const count of [0, 1, 2, 11, 21]) {
        expect(i18next.t(COUNT_KEY, { count })).not.toContain(COUNT_KEY);
      }
    }
  });
});

describe('interpolated delete confirmations', () => {
  it.each(['en', 'zh'] as const)('substitutes name and count in %s', async (lng) => {
    await i18next.changeLanguage(lng);

    const provider = i18next.t('options.models.deleteProviderConfirm', {
      name: 'Acme',
      count: 3,
    });
    expect(provider).toContain('Acme');
    expect(provider).toContain('3');
    expect(provider).not.toContain('{{');

    const model = i18next.t('options.models.deleteModelConfirm', { name: 'GPT-4o' });
    expect(model).toContain('GPT-4o');
    expect(model).not.toContain('{{');
  });
});

describe('locale bundles stay in sync', () => {
  /** Collects every leaf key path in a nested translation object. */
  function leafKeys(node: unknown, prefix = ''): string[] {
    if (typeof node !== 'object' || node === null) return [prefix];
    return Object.entries(node).flatMap(([key, value]) =>
      leafKeys(value, prefix ? `${prefix}.${key}` : key),
    );
  }

  it('defines the same keys in en and zh', () => {
    // `zh` is typed as `TranslationSchema`, which catches missing keys at
    // compile time; this also catches extras that TS would allow through a
    // widened object literal.
    expect(leafKeys(zh).sort()).toEqual(leafKeys(en).sort());
  });

  it('leaves no empty strings', () => {
    for (const [locale, bundle] of [['en', en], ['zh', zh]] as const) {
      for (const key of leafKeys(bundle)) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            bundle,
          );
        expect(String(value).trim(), `${locale}:${key} is empty`).not.toBe('');
      }
    }
  });
});

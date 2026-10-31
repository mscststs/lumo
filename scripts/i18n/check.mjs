#!/usr/bin/env node
/**
 * Locale contract checker.
 *
 * Run with `npm run i18n:check`. It fails on:
 *  - a bundle missing a key that exists in `en.json` (or carrying an extra one),
 *  - an empty translation,
 *  - a `{{placeholder}}` that does not match the English source exactly,
 *  - a missing CLDR plural category for a `_one`-style plural key.
 *
 * It is intentionally dependency-free and works on the JSON files directly, so
 * it can run in CI without booting i18next or a browser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const localesDir = join(root, 'i18n/locales');

/** @param {unknown} value @param {string} prefix @param {Map<string,string>} out */
function flatten(value, prefix, out) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof value === 'string') {
    out.set(prefix, value);
  }
}

const en = new Map();
flatten(JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8')), '', en);

const placeholders = (text) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort();

/** Strip i18next's plural suffix to find the base key. */
const pluralSuffix = /_(zero|one|two|few|many|other)$/;

const failures = [];
const files = readdirSync(localesDir).filter((file) => file.endsWith('.json'));

for (const file of files) {
  const tag = file.replace(/\.json$/, '');
  const bundle = new Map();
  flatten(JSON.parse(readFileSync(join(localesDir, file), 'utf8')), '', bundle);

  for (const [key, english] of en) {
    const translated = bundle.get(key);
    if (translated === undefined) {
      failures.push(`${tag}: missing key "${key}"`);
      continue;
    }
    if (translated.trim() === '') {
      failures.push(`${tag}: empty value for "${key}"`);
    }
    const expected = placeholders(english);
    const actual = placeholders(translated);
    if (expected.join(',') !== actual.join(',')) {
      failures.push(
        `${tag}: placeholder mismatch in "${key}" — expected {${expected.join(', ')}}, got {${actual.join(', ')}}`
      );
    }
  }

  for (const key of bundle.keys()) {
    if (en.has(key)) continue;
    // Extra plural categories (`_many`, `_few`, …) are expected: English only
    // defines `_one`/`_other`, while e.g. French also needs `_many`.
    const base = key.replace(pluralSuffix, '');
    if (pluralSuffix.test(key) && en.has(`${base}_other`)) continue;
    failures.push(`${tag}: unknown key "${key}"`);
  }

  // Plural categories: i18next resolves `key_<category>` from Intl.PluralRules.
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  for (const key of en.keys()) {
    if (!pluralSuffix.test(key)) continue;
    const base = key.replace(pluralSuffix, '');
    if (!en.has(`${base}_other`)) continue;
    for (const category of categories) {
      if (!bundle.has(`${base}_${category}`)) {
        failures.push(`${tag}: plural category "${base}_${category}" missing`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`i18n check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`i18n check passed: ${files.length} locales, ${en.size} keys each.`);

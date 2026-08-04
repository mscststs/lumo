import { readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');

/**
 * Load a fixture into the ambient jsdom `document`.
 *
 * Assigning `documentElement.innerHTML` rather than using `document.write` keeps
 * the existing `window` (and therefore any registered globals) alive, which
 * matters because the page modules read `document.defaultView`. The cost is that
 * attributes on `<html>` itself are not part of `innerHTML`, so they are copied
 * across explicitly — `lang` in particular is real page metadata that `page_read`
 * reports, and silently losing it would make fixtures diverge from real pages.
 *
 * Note: inline `<script>` in a fixture does not execute on this path. Anything a
 * test needs scripted — attaching a shadow root, say — has to be done from the
 * test itself, which is also clearer about what is being exercised.
 */
export function loadFixture(name: string): Document {
  const html = fixtureHtml(name);
  const withoutDoctype = html.replace(/<!DOCTYPE[^>]*>/i, '').trim();
  const rootTag = /^<html([^>]*)>/i.exec(withoutDoctype);

  document.documentElement.innerHTML = withoutDoctype
    .replace(/^<html[^>]*>/i, '')
    .replace(/<\/html>\s*$/i, '');

  for (const attribute of [...document.documentElement.attributes]) {
    document.documentElement.removeAttribute(attribute.name);
  }
  for (const [, name_, value] of (rootTag?.[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) {
    document.documentElement.setAttribute(name_!, value!);
  }

  return document;
}

/** Raw fixture text, for tests that want to parse it themselves. */
export function fixtureHtml(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

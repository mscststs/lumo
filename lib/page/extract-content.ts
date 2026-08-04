import { Readability, isProbablyReaderable } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { PageReadMode } from './messages';

export interface ExtractOptions {
  doc: Document;
  mode: PageReadMode;
  selector?: string;
  includeImages: boolean;
  includeLinks: boolean;
}

export interface ExtractSuccess {
  resolvedMode: 'article' | 'full';
  markdown: string;
  title: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  publishedTime?: string;
  lang?: string;
}

export type ExtractResult = ExtractSuccess | { error: string };

/**
 * Below this, Readability's "article" is a husk rather than a page.
 * Measured in research §6: dashboards come back at 78 chars, login pages at 46.
 */
const MIN_ARTICLE_LENGTH = 200;

/**
 * Turndown drops tables entirely by default; the rules below restore GFM pipe
 * tables. `<thead>` is frequently absent in the wild (browser-use hits the same
 * problem and normalises the DOM in `html_serializer.py:172`), so the header row
 * is detected as "first row that contains a <th>".
 */
export function createTurndown(includeImages: boolean, includeLinks: boolean): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });

  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content) => ` ${content.replace(/\n/g, ' ').trim()} |`,
  });
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const el = node as HTMLTableRowElement;
      let out = `|${content}\n`;
      const isHeader =
        el.parentElement?.nodeName === 'THEAD' ||
        (!previousRow(el) && !!el.querySelector('th'));
      if (isHeader) out += `|${' --- |'.repeat(el.children.length)}\n`;
      return out;
    },
  });
  td.addRule('table', { filter: 'table', replacement: (content) => `\n${content}\n` });
  // A <caption> outside a row would otherwise be swallowed by the table rule.
  td.addRule('tableCaption', {
    filter: 'caption',
    replacement: (content) => `${content.trim()}\n\n`,
  });
  td.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  });

  // `td.remove('img')` does not work here: Turndown's built-in `image` rule is
  // matched before the removal list, so the image still renders. Overriding the
  // rule is the only way to actually suppress it.
  if (!includeImages) {
    td.addRule('dropImage', { filter: ['img'], replacement: () => '' });
  }
  if (!includeLinks) {
    td.addRule('plainLink', { filter: 'a', replacement: (content) => content });
  }
  // Never let script/style leak into prose.
  td.remove(['script', 'style', 'noscript', 'template']);
  return td;
}

/**
 * First row of a table, accounting for the `<tbody>` the parser injects: a row
 * that is first inside `<tbody>` but whose table has a `<thead>` is not a header.
 */
function previousRow(row: HTMLTableRowElement): Element | null {
  if (row.previousElementSibling) return row.previousElementSibling;
  const section = row.parentElement;
  if (!section) return null;
  const sectionName = section.nodeName;
  if (sectionName !== 'TBODY' && sectionName !== 'TFOOT') return null;
  let previous = section.previousElementSibling;
  while (previous) {
    if (previous.querySelector('tr')) return previous;
    previous = previous.previousElementSibling;
  }
  return null;
}

/** Tags that carry no prose. Mirrors browser-use `html_serializer.py:70`. */
const FULL_MODE_STRIP = [
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link',
  'nav', 'header', 'footer', 'aside',
];

export function extractContent(options: ExtractOptions): ExtractResult {
  const { doc, mode, selector, includeImages, includeLinks } = options;
  const td = createTurndown(includeImages, includeLinks);

  const root = selector ? doc.querySelector(selector) : null;
  if (selector && !root) return { error: `Element not found: ${selector}` };

  // A sub-tree request is always a `full` extraction — Readability only makes
  // sense against a whole document.
  const wantArticle =
    !root && (mode === 'article' || (mode === 'auto' && safeIsReaderable(doc)));

  if (wantArticle) {
    const article = parseArticle(doc);
    // Guard against the degenerate output measured in research §6 (dashboard →
    // 78 chars). `article` mode is explicit, so honour it even if short; `auto`
    // falls through to `full`.
    if (article && (mode === 'article' || (article.length ?? 0) > MIN_ARTICLE_LENGTH)) {
      return {
        resolvedMode: 'article',
        markdown: td.turndown(article.content ?? '').trim(),
        title: article.title ?? doc.title,
        byline: article.byline ?? undefined,
        excerpt: article.excerpt ?? undefined,
        siteName: article.siteName ?? undefined,
        publishedTime: article.publishedTime ?? undefined,
        lang: article.lang ?? undefined,
      };
    }
  }

  // `full` mode: keep the whole subtree, only strip non-prose chrome.
  const scope = (root ?? doc.body ?? doc.documentElement).cloneNode(true) as Element;
  scope.querySelectorAll(FULL_MODE_STRIP.join(',')).forEach((el) => el.remove());
  // Tracking pixels / base64 placeholders — browser-use strips these too.
  scope.querySelectorAll('img[src^="data:image/"]').forEach((el) => el.remove());
  // Elements hidden inline commonly hold SPA hydration state; `getComputedStyle`
  // is unavailable on a detached clone, so the inline attribute is the signal.
  scope.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style')?.replace(/\s/g, '') ?? '';
    if (style.includes('display:none') || style.includes('visibility:hidden')) el.remove();
  });
  scope.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((el) => el.remove());
  // `data-*` frequently carries JSON payloads; drop before serialising.
  scope.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('data-')) el.removeAttribute(attr.name);
    }
  });

  return {
    resolvedMode: 'full',
    markdown: td.turndown(scope.innerHTML).trim(),
    title: doc.title,
  };
}

/**
 * `auto` routing signal. Wrapped because Readability's readerability check
 * walks the live DOM and can throw on exotic documents; a failed probe should
 * degrade to `full`, not fail the tool.
 */
function safeIsReaderable(doc: Document): boolean {
  try {
    return isProbablyReaderable(doc);
  } catch {
    return false;
  }
}

type ParsedArticle = NonNullable<ReturnType<Readability['parse']>>;

function parseArticle(doc: Document): ParsedArticle | null {
  try {
    // Readability mutates the document it is given; always hand it a clone.
    return new Readability(doc.cloneNode(true) as Document, { charThreshold: 200 }).parse();
  } catch {
    return null;
  }
}

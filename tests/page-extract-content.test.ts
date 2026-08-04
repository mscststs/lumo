/**
 * @vitest-environment jsdom
 *
 * Content extraction: Markdown fidelity, mode routing and noise removal.
 *
 * The routing tests carry most of the weight. Readability alone returns 78
 * characters on a dashboard and 46 on a login page (research.md §6), so trusting
 * it unconditionally would make `page_read` *worse* than the `page_get_text` it
 * replaces on exactly the app-like pages an agent spends most of its time on.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { extractContent, createTurndown } from '@/lib/page/extract-content';
import { loadFixture } from './helpers/fixtures';

function read(options: {
  mode?: 'auto' | 'article' | 'full';
  selector?: string;
  includeImages?: boolean;
  includeLinks?: boolean;
} = {}) {
  const result = extractContent({
    doc: document,
    mode: options.mode ?? 'auto',
    selector: options.selector,
    includeImages: options.includeImages ?? true,
    includeLinks: options.includeLinks ?? true,
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('extractContent: article mode', () => {
  beforeEach(() => {
    loadFixture('article-page.html');
  });

  it('produces markdown with heading levels', () => {
    const { markdown } = read();
    expect(markdown).toMatch(/^##? Acme Corp Reports Record Q3 Revenue$/m);
    expect(markdown).toMatch(/^##+ Segment performance$/m);
    expect(markdown).toMatch(/^###+ Key figures$/m);
  });

  it('preserves image alt text and src', () => {
    expect(read().markdown).toMatch(/!\[Acme Corp headquarters at sunset\]\(\S*\/img\/hq-exterior\.jpg\)/);
  });

  it('preserves link urls', () => {
    expect(read().markdown).toMatch(/\[AcmeCloud\]\(\S*\/products\/acmecloud\)/);
  });

  it('renders tables as GFM pipe tables', () => {
    const { markdown } = read();
    // The fixture's table has no <thead>, so the header row has to be detected
    // heuristically. Turndown drops tables entirely without these rules.
    expect(markdown).toContain('| Segment | Q3 2026 | Q3 2025 | Change |');
    expect(markdown).toContain('| --- | --- | --- | --- |');
    expect(markdown).toContain('| AcmeCloud | 2,410 | 1,780 | +35% |');
  });

  it('preserves blockquotes, emphasis and both list kinds', () => {
    const { markdown } = read();
    expect(markdown).toMatch(/^> We are seeing durable demand/m);
    expect(markdown).toContain('**record third-quarter revenue**');
    expect(markdown).toContain('_continued double-digit growth_');
    expect(markdown).toMatch(/^-\s+Revenue: \*\*\$4\.2B\*\*/m);
    expect(markdown).toMatch(/^1\.\s+\[AcmeCloud opens EU region\]/m);
  });

  it('strips navigation, ads, cookie banners and JSON blobs', () => {
    const { markdown } = read();
    // The 4/4 noise exclusion measured in research.md §5.
    expect(markdown).not.toContain('Careers');           // nav
    expect(markdown).not.toContain('Buy AcmeCloud now'); // ad
    expect(markdown).not.toContain('Accept all');        // cookie banner
    expect(markdown).not.toContain('"props"');           // SPA state blob
    expect(markdown).not.toContain('Hydration');         // hidden state blob
    expect(markdown).not.toContain('Ghost button');      // display:none
  });

  it('reports article metadata', () => {
    const article = read();
    expect(article.resolvedMode).toBe('article');
    // Readability reports the document title, not the <h1> — the two differ on
    // real news sites and the document title is the more reliable identifier.
    expect(article.title).toContain('Acme Corp Newsroom');
    expect(article.excerpt).toBeTruthy();
  });

  it('is far smaller than the legacy snapshot for the same page', () => {
    // research.md measured 1258 vs 6426. A loose ceiling keeps this from
    // becoming brittle while still catching a regression to whole-page dumps.
    expect(read().markdown.length).toBeLessThan(3000);
  });

  it('omits images when asked', () => {
    const { markdown } = read({ includeImages: false });
    expect(markdown).not.toContain('![');
    expect(markdown).toContain('record third-quarter revenue');
  });

  it('keeps link text but drops urls when asked', () => {
    const { markdown } = read({ includeLinks: false });
    expect(markdown).toContain('AcmeCloud');
    expect(markdown).not.toContain('](/products/acmecloud)');
  });
});

describe('extractContent: mode routing', () => {
  it('routes an article-like page to article mode', () => {
    loadFixture('article-page.html');
    expect(read().resolvedMode).toBe('article');
  });

  it('falls back to full mode for a dashboard', () => {
    loadFixture('dashboard.html');
    const result = read();
    // Readability yields 78 unusable characters here; `full` must take over.
    expect(result.resolvedMode).toBe('full');
    expect(result.markdown).toContain('#1001');
    expect(result.markdown).toContain('Shipped');
    expect(result.markdown).toContain('$4.2M');
    expect(result.markdown.length).toBeGreaterThan(100);
  });

  it('falls back to full mode for a login page', () => {
    loadFixture('login.html');
    const result = read();
    expect(result.resolvedMode).toBe('full');
    expect(result.markdown).toContain('Sign in');
    expect(result.markdown).toContain('Forgot password?');
  });

  it('falls back to full mode for a search results page', () => {
    loadFixture('search-results.html');
    const result = read();
    expect(result.resolvedMode).toBe('full');
    expect(result.markdown).toContain('Result 0 title');
    expect(result.markdown).toContain('Result 9 title');
    expect(result.markdown).toContain('/r/0');
  });

  it('honours explicit article mode even when output is short', () => {
    loadFixture('dashboard.html');
    // `article` is an explicit instruction; the length guard exists to protect
    // `auto`'s guess, not to override the caller.
    expect(read({ mode: 'article' }).resolvedMode).toBe('article');
  });

  it('honours explicit full mode on an article page', () => {
    loadFixture('article-page.html');
    const result = read({ mode: 'full' });
    expect(result.resolvedMode).toBe('full');
    // `full` keeps the comment form that Readability discards.
    expect(result.markdown).toContain('Post comment');
  });

  it('treats a selector request as full mode', () => {
    loadFixture('article-page.html');
    const result = read({ selector: 'section[aria-label="Comments"]', mode: 'auto' });
    expect(result.resolvedMode).toBe('full');
    // Turndown escapes `_` so it is not read as emphasis on the way back in.
    expect(result.markdown).toContain('alex\\_t');
    expect(result.markdown).toContain('Impressive cloud numbers.');
    expect(result.markdown).not.toContain('Record Q3 Revenue');
  });

  it('reports a missing selector as an error', () => {
    loadFixture('article-page.html');
    const result = extractContent({
      doc: document,
      mode: 'auto',
      selector: '#does-not-exist',
      includeImages: true,
      includeLinks: true,
    });
    expect(result).toEqual({ error: 'Element not found: #does-not-exist' });
  });
});

describe('extractContent: full mode', () => {
  it('strips script/style/nav/header/footer/aside', () => {
    document.body.innerHTML = `
      <header><a href="/">Home</a></header>
      <nav><a href="/news">News</a></nav>
      <main><p>Keep this prose.</p></main>
      <aside><p>Sidebar noise</p></aside>
      <footer><p>Footer noise</p></footer>
      <script>console.log('script noise')</script>
      <style>.x { color: red }</style>
    `;
    const { markdown } = read({ mode: 'full' });
    expect(markdown).toContain('Keep this prose.');
    expect(markdown).not.toContain('Sidebar noise');
    expect(markdown).not.toContain('Footer noise');
    expect(markdown).not.toContain('script noise');
    expect(markdown).not.toContain('color: red');
    expect(markdown).not.toContain('News');
  });

  it('drops base64 inline images', () => {
    document.body.innerHTML = `
      <p>Body</p>
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="tracker">
      <img src="/real.jpg" alt="real image">
    `;
    const { markdown } = read({ mode: 'full' });
    expect(markdown).not.toContain('data:image/');
    expect(markdown).not.toContain('tracker');
    expect(markdown).toContain('real image');
  });

  it('drops data-* attributes', () => {
    document.body.innerHTML = '<p data-state=\'{"secret":"payload"}\'>Visible text</p>';
    const { markdown } = read({ mode: 'full' });
    expect(markdown).toContain('Visible text');
    expect(markdown).not.toContain('payload');
  });

  it('drops inline-hidden state containers', () => {
    document.body.innerHTML = `
      <code id="bpr-guid-1" style="display:none">{"$type":"Hydration"}</code>
      <div aria-hidden="true">Decorative</div>
      <p>Real content</p>
    `;
    const { markdown } = read({ mode: 'full' });
    expect(markdown).not.toContain('Hydration');
    expect(markdown).not.toContain('Decorative');
    expect(markdown).toContain('Real content');
  });

  it('keeps main content that Readability would have discarded', () => {
    loadFixture('dashboard.html');
    const { markdown } = read({ mode: 'full' });
    expect(markdown).toContain('| Order | Status |');
    expect(markdown).toContain('Export CSV');
  });
});

describe('createTurndown: table rules', () => {
  it('detects a header row inside an explicit thead', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const markdown = createTurndown(true, true).turndown(document.body.innerHTML);
    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| 1 | 2 |');
  });

  it('emits exactly one separator row for a thead-less table', () => {
    document.body.innerHTML = '<table><tr><th>A</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></table>';
    const markdown = createTurndown(true, true).turndown(document.body.innerHTML);
    expect(markdown.match(/\| --- \|/g)).toHaveLength(1);
  });

  it('does not treat the first body row as a header when a thead exists', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>A</th></tr></thead>
        <tbody><tr><td>1</td></tr></tbody>
      </table>
    `;
    const markdown = createTurndown(true, true).turndown(document.body.innerHTML);
    expect(markdown.match(/\| --- \|/g)).toHaveLength(1);
  });

  it('does not treat a body-only table as having a header', () => {
    document.body.innerHTML = '<table><tr><td>1</td></tr><tr><td>2</td></tr></table>';
    const markdown = createTurndown(true, true).turndown(document.body.innerHTML);
    expect(markdown).not.toContain('---');
  });
});

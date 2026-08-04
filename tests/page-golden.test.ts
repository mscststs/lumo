/**
 * @vitest-environment jsdom
 *
 * Golden-fixture assertions across the whole handler path.
 *
 * These go through `handlePageRequest`, so they cover extraction, snapshotting,
 * output limits and ref allocation as one pipeline — the level at which the spec's
 * acceptance criteria are written.
 *
 * Deliberately not `toMatchSnapshot`: a byte-level baseline turns every harmless
 * distiller tweak into a failure, which teaches people to re-record expectations
 * without reading them. Asserting "these structures present, this noise absent"
 * survives refactoring and still catches the regressions that matter.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { handlePageRequest } from '@/lib/page/handlers';
import { resetRefRegistry } from '@/lib/page/ref-registry';
import { DEFAULT_MAX_CHARS } from '@/lib/page/output-limit';
import type { PageFindResponse, PageReadResponse, PageSnapshotResponse } from '@/lib/page/messages';
import { loadFixture } from './helpers/fixtures';

async function read(
  overrides: Partial<Parameters<typeof handlePageRequest>[0]> = {},
): Promise<PageReadResponse> {
  const response = await handlePageRequest({
    type: 'lumo:page:read',
    mode: 'auto',
    includeImages: true,
    includeLinks: true,
    ...overrides,
  } as Parameters<typeof handlePageRequest>[0]);
  if (!response.ok) throw new Error(response.error);
  return response as PageReadResponse;
}

async function snapshot(
  overrides: Partial<Parameters<typeof handlePageRequest>[0]> = {},
): Promise<PageSnapshotResponse> {
  const response = await handlePageRequest({
    type: 'lumo:page:snapshot',
    interactiveOnly: false,
    ...overrides,
  } as Parameters<typeof handlePageRequest>[0]);
  if (!response.ok) throw new Error(response.error);
  return response as PageSnapshotResponse;
}

beforeEach(() => {
  resetRefRegistry();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('golden: article-page.html', () => {
  beforeEach(() => {
    loadFixture('article-page.html');
  });

  it('page_read output contains every structural marker', async () => {
    const { markdown } = await read();
    // The 5 structure checks from research.md §5.
    expect(markdown).toMatch(/^#+ Acme Corp Reports Record Q3 Revenue$/m);
    expect(markdown).toMatch(/!\[Acme Corp headquarters at sunset\]/);
    expect(markdown).toMatch(/\[AcmeCloud\]\(\S+\)/);
    expect(markdown).toContain('| --- | --- | --- | --- |');
    expect(markdown).toMatch(/^> We are seeing durable demand/m);
  });

  it('page_read excludes all four noise sources', async () => {
    const { markdown } = await read();
    expect(markdown).not.toContain('Careers');            // nav
    expect(markdown).not.toContain('Buy AcmeCloud now');  // ad
    expect(markdown).not.toContain('Reject non-essential'); // cookie banner
    expect(markdown).not.toContain('"buildId"');          // JSON blob
  });

  it('page_read output is far smaller than the legacy snapshot', async () => {
    // research.md measured 1258 vs 6426 characters. A loose ceiling keeps this
    // from breaking on formatting changes while still catching a page dump.
    expect((await read()).markdown.length).toBeLessThan(3000);
  });

  it('page_read reports metadata and the mode it resolved to', async () => {
    const article = await read();
    expect(article.resolvedMode).toBe('article');
    expect(article.title).toBeTruthy();
    expect(article.lang).toBe('en');
    expect(article.limit.truncated).toBe(false);
  });

  it('page_snapshot exposes headings, urls, states and refs', async () => {
    const { snapshot: tree, refCount } = await snapshot();
    expect(tree).toContain('heading "Acme Corp Reports Record Q3 Revenue" [level=1]');
    expect(tree).toContain('/url: /products/acmecloud');
    expect(tree).toContain('img "Acme Corp headquarters at sunset"');
    expect(tree).toContain('columnheader "Segment"');
    expect(tree).toContain('button "Post comment" [disabled]');
    expect(refCount).toBeGreaterThan(10);
  });

  it('page_snapshot excludes the noise the legacy snapshot let through', async () => {
    const { snapshot: tree } = await snapshot();
    expect(tree).not.toContain('buildId');       // JSON blob
    expect(tree).not.toContain('Hydration');     // hidden state blob
    expect(tree).not.toContain('Ghost button');  // display:none
    expect(tree).not.toContain('NewsProducts');  // glued text
  });

  it('page_snapshot sees shadow DOM content that innerText cannot', async () => {
    // The fixture attaches this via an inline script, which does not run when the
    // fixture is assigned as HTML, so the test does it explicitly.
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <section aria-label="Newsletter">
        <h2>Subscribe to the Acme brief</h2>
        <label for="e">Email address</label>
        <input id="e" type="email" placeholder="you@company.com">
        <button>Subscribe</button>
      </section>
    `;
    const { snapshot: tree } = await snapshot();
    expect(tree).toContain('region "Newsletter"');
    expect(tree).toMatch(/textbox "Email address" \[ref=e\d+\]/);
    expect(tree).toContain('/placeholder: you@company.com');
  });
});

describe('golden: app-like pages do not degrade', () => {
  it('dashboard keeps its KPIs and table', async () => {
    loadFixture('dashboard.html');
    const result = await read();
    expect(result.resolvedMode).toBe('full');
    expect(result.markdown).toContain('$4.2M');
    expect(result.markdown).toContain('18,204');
    expect(result.markdown).toContain('#1001');
    expect(result.markdown).toContain('Shipped');
    expect(result.markdown).toContain('| Order | Status |');
  });

  it('routing to full mode retains what article mode would have dropped', async () => {
    loadFixture('dashboard.html');
    const auto = await read();
    const forced = await read({ mode: 'article' });
    expect(forced.resolvedMode).toBe('article');

    // The comparison that justifies the routing, stated as content rather than
    // length: on an app page Readability keeps the chrome and throws away the
    // page's own heading and controls, which is exactly backwards for an agent.
    expect(auto.markdown).toContain('Dashboard');
    expect(forced.markdown).not.toContain('Dashboard');
    expect(auto.markdown).toContain('Export CSV');
    expect(forced.markdown).not.toContain('Export CSV');
    expect(forced.markdown).toContain('Reports'); // nav survived instead
  });

  it('login page keeps its fields', async () => {
    loadFixture('login.html');
    const result = await read();
    expect(result.resolvedMode).toBe('full');
    expect(result.markdown).toContain('Sign in');
    expect(result.markdown).toContain('Forgot password?');
    // Readability drops the heading and the submit button on this page.
    const forced = await read({ mode: 'article' });
    expect(forced.markdown).not.toContain('Sign in');
  });

  it('login page snapshot exposes every control with a ref', async () => {
    loadFixture('login.html');
    const { snapshot: tree } = await snapshot();
    expect(tree).toMatch(/textbox "Email" \[ref=e\d+\]/);
    expect(tree).toMatch(/textbox "Password" \[ref=e\d+\]/);
    expect(tree).toMatch(/checkbox "Remember me".*\[ref=e\d+\]/);
    expect(tree).toMatch(/button "Sign in" \[ref=e\d+\]/);
  });

  it('search results keep every result and link', async () => {
    loadFixture('search-results.html');
    const result = await read();
    expect(result.resolvedMode).toBe('full');
    for (const index of [0, 5, 9]) {
      expect(result.markdown).toContain(`Result ${index} title`);
      expect(result.markdown).toContain(`/r/${index}`);
    }
  });

  it('deeply nested page keeps its deep content', async () => {
    loadFixture('deep-nested.html');
    const { snapshot: tree } = await snapshot();
    // `maxDepth: 8` lost both of these silently.
    expect(tree).toContain('Buried headline');
    expect(tree).toContain('button "Buy now"');
    const { markdown } = await read({ mode: 'full' });
    expect(markdown).toContain('Deeply nested prose that must not disappear.');
  });
});

describe('golden: large pages are bounded and searchable', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main><h1>Inventory</h1><ul>${Array.from(
        { length: 400 },
        (_, i) => `<li><span>Widget ${i}</span><button>Add ${i} to cart</button></li>`,
      ).join('')}</ul></main>
    `;
  });

  it('truncates a huge snapshot and says so', async () => {
    const result = await snapshot();
    expect(result.snapshot.length).toBe(DEFAULT_MAX_CHARS);
    expect(result.limit.truncated).toBe(true);
    // Without this the model believes it saw the whole page.
    expect(result.limit.totalChars).toBeGreaterThan(DEFAULT_MAX_CHARS);
  });

  it('pages through a huge snapshot via offset', async () => {
    const first = await snapshot({ maxChars: 5_000 });
    const second = await snapshot({ maxChars: 5_000, offset: 5_000 });
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(second.limit.offset).toBe(5_000);
  });

  it('finds one element for a fraction of the snapshot cost', async () => {
    const whole = await snapshot({ maxChars: 200_000 });
    const found = await handlePageRequest({
      type: 'lumo:page:find',
      text: 'Add 250 to cart',
      context: 2,
    });
    expect(found.ok).toBe(true);
    const result = found as PageFindResponse;
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]!.ref).toMatch(/^e\d+$/);
    expect(result.limit.totalChars).toBeLessThan(whole.limit.totalChars / 100);
  });

  it('keeps interactiveOnly output smaller than the full tree', async () => {
    const full = await snapshot({ maxChars: 200_000 });
    const lean = await snapshot({ interactiveOnly: true, maxChars: 200_000 });
    expect(lean.snapshot.length).toBeLessThan(full.snapshot.length);
    expect(lean.snapshot).not.toContain('Widget 0');
    expect(lean.snapshot).toContain('Add 0 to cart');
  });
});

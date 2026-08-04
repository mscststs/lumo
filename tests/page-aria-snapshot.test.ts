/**
 * @vitest-environment jsdom
 *
 * ARIA snapshot: text handling, structure, distiller and refs.
 *
 * Assertions are on *structural markers present* and *noise absent*, never on the
 * whole output string. A byte-level snapshot would turn every harmless distiller
 * tweak into a failure, which trains people to update expectations without
 * reading them (testing.md §3).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAriaTree,
  captureAriaSnapshot,
  distill,
  type AriaNode,
} from '@/lib/page/aria-snapshot';
import { resetRefRegistry } from '@/lib/page/ref-registry';
import { loadFixture } from './helpers/fixtures';

function snapshotOf(html: string): string {
  document.body.innerHTML = html;
  return captureAriaSnapshot(document).snapshot;
}

beforeEach(() => {
  resetRefRegistry();
  document.body.innerHTML = '';
});

describe('aria snapshot: text handling', () => {
  it('separates block-level text instead of gluing it', () => {
    const snapshot = snapshotOf(`
      <nav><a href="/n">News</a><a href="/p">Products</a><a href="/x">Pricing</a></nav>
    `);
    // The old snapshot produced `NewsProductsPricing` by concatenating without
    // a separator (spec defect A).
    expect(snapshot).not.toContain('NewsProducts');
    expect(snapshot).toContain('"News"');
    expect(snapshot).toContain('"Products"');
  });

  it('separates adjacent inline text nodes across block boundaries', () => {
    const snapshot = snapshotOf('<div><p>First</p><p>Second</p></div>');
    expect(snapshot).not.toContain('FirstSecond');
  });

  it('excludes script/style/template content', () => {
    const snapshot = snapshotOf(`
      <p>Real prose.</p>
      <script type="application/json">{"props":{"pageProps":{"id":"a-1024"}}}</script>
      <style>.x { color: red }</style>
      <template><button>Templated</button></template>
    `);
    // The SPA state blob used to occupy the first ~800 characters of the budget.
    expect(snapshot).not.toContain('"props"');
    expect(snapshot).not.toContain('pageProps');
    expect(snapshot).not.toContain('color: red');
    expect(snapshot).not.toContain('Templated');
    expect(snapshot).toContain('Real prose.');
  });

  it('excludes display:none subtrees', () => {
    const snapshot = snapshotOf(`
      <p>Visible</p>
      <div style="display:none"><button>Ghost button</button></div>
    `);
    expect(snapshot).not.toContain('Ghost button');
    expect(snapshot).toContain('Visible');
  });

  it('excludes visibility:hidden and aria-hidden subtrees', () => {
    const snapshot = snapshotOf(`
      <div style="visibility:hidden"><button>Invisible</button></div>
      <div aria-hidden="true"><button>Hidden from a11y</button></div>
      <button hidden>Hidden attribute</button>
      <button>Real</button>
    `);
    expect(snapshot).not.toContain('Invisible');
    expect(snapshot).not.toContain('Hidden from a11y');
    expect(snapshot).not.toContain('Hidden attribute');
    expect(snapshot).toContain('"Real"');
  });

  it('excludes hidden inline JSON state blobs', () => {
    const snapshot = snapshotOf(`
      <code id="bpr-guid-8812" style="display:none">{"$type":"com.acme.state.Hydration"}</code>
      <p>Article body.</p>
    `);
    expect(snapshot).not.toContain('Hydration');
  });
});

describe('aria snapshot: structure', () => {
  it('emits heading levels', () => {
    const snapshot = snapshotOf('<h1>Title</h1><h2>Section</h2><h4>Sub</h4>');
    expect(snapshot).toContain('heading "Title" [level=1]');
    expect(snapshot).toContain('heading "Section" [level=2]');
    expect(snapshot).toContain('heading "Sub" [level=4]');
  });

  it('respects aria-level on an explicit heading role', () => {
    const snapshot = snapshotOf('<div role="heading" aria-level="3">Custom</div>');
    expect(snapshot).toContain('heading "Custom" [level=3]');
  });

  it('emits link urls as /url props', () => {
    const snapshot = snapshotOf('<a href="/authors/jane">Jane Doe</a>');
    expect(snapshot).toContain('link "Jane Doe"');
    expect(snapshot).toContain('/url: /authors/jane');
  });

  it('emits image accessible names', () => {
    const snapshot = snapshotOf('<img src="/hq.jpg" alt="Acme headquarters at sunset">');
    expect(snapshot).toContain('img "Acme headquarters at sunset"');
  });

  it('emits table role hierarchy', () => {
    const snapshot = snapshotOf(`
      <table>
        <caption>Revenue</caption>
        <tr><th>Segment</th><th>Q3</th></tr>
        <tr><td>Cloud</td><td>2,410</td></tr>
      </table>
    `);
    expect(snapshot).toContain('table "Revenue"');
    expect(snapshot).toContain('rowgroup');
    expect(snapshot).toContain('row');
    expect(snapshot).toContain('columnheader "Segment"');
    expect(snapshot).toContain('cell "Cloud"');
    expect(snapshot).toContain('cell "2,410"');
  });

  it('emits rowheader for a row-scoped th', () => {
    const snapshot = snapshotOf('<table><tr><th scope="row">Cloud</th><td>2,410</td></tr></table>');
    expect(snapshot).toContain('rowheader "Cloud"');
  });

  it('emits disabled state', () => {
    const snapshot = snapshotOf('<button disabled>Post comment</button>');
    expect(snapshot).toContain('button "Post comment" [disabled]');
  });

  it('emits aria-disabled state', () => {
    const snapshot = snapshotOf('<div role="button" aria-disabled="true">Submit</div>');
    expect(snapshot).toContain('[disabled]');
  });

  it('emits checked state for checkboxes and radios', () => {
    document.body.innerHTML = `
      <label for="a">Accept</label><input id="a" type="checkbox" checked>
      <label for="b">Decline</label><input id="b" type="checkbox">
    `;
    const snapshot = captureAriaSnapshot(document).snapshot;
    expect(snapshot).toMatch(/checkbox "Accept".*\[checked\]/);
    expect(snapshot).toMatch(/checkbox "Decline".*\[unchecked\]/);
  });

  it('emits mixed checked state', () => {
    const snapshot = snapshotOf('<div role="checkbox" aria-checked="mixed" aria-label="Some">x</div>');
    expect(snapshot).toContain('[checked=mixed]');
  });

  it('emits expanded state', () => {
    const snapshot = snapshotOf('<button aria-expanded="false" aria-label="Menu">≡</button>');
    expect(snapshot).toContain('[collapsed]');
  });

  it('emits placeholders as props', () => {
    const snapshot = snapshotOf('<label for="e">Email address</label><input id="e" placeholder="you@company.com">');
    expect(snapshot).toContain('textbox "Email address"');
    expect(snapshot).toContain('/placeholder: you@company.com');
  });

  it('maps input types to distinct roles', () => {
    const snapshot = snapshotOf(`
      <input type="search" aria-label="Search site">
      <input type="number" aria-label="Quantity">
      <input type="radio" aria-label="Option A">
      <input type="range" aria-label="Volume">
    `);
    expect(snapshot).toContain('searchbox "Search site"');
    expect(snapshot).toContain('spinbutton "Quantity"');
    expect(snapshot).toContain('radio "Option A"');
    expect(snapshot).toContain('slider "Volume"');
  });

  it('emits landmark roles', () => {
    const snapshot = snapshotOf(`
      <header><p>top</p></header><nav aria-label="Main"><a href="/">Home</a></nav>
      <main><p>body</p></main><aside aria-label="Related"><p>side</p></aside>
      <footer><p>bottom</p></footer>
    `);
    expect(snapshot).toContain('banner');
    expect(snapshot).toContain('navigation "Main"');
    expect(snapshot).toContain('main');
    expect(snapshot).toContain('complementary "Related"');
    expect(snapshot).toContain('contentinfo');
  });

  it('treats an unlabelled section as a plain wrapper, a labelled one as a region', () => {
    expect(snapshotOf('<section><p>plain</p></section>')).not.toContain('region');
    expect(snapshotOf('<section aria-label="Newsletter"><p>x</p></section>')).toContain('region "Newsletter"');
  });

  it('traverses shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <section aria-label="Newsletter">
        <h2>Subscribe to the Acme brief</h2>
        <label for="e">Email address</label>
        <input id="e" type="email" placeholder="you@company.com">
        <button>Subscribe</button>
      </section>
    `;
    const snapshot = captureAriaSnapshot(document).snapshot;
    // `innerText` cannot see any of this, which is why shadow support matters.
    expect(snapshot).toContain('region "Newsletter"');
    expect(snapshot).toContain('heading "Subscribe to the Acme brief"');
    expect(snapshot).toContain('textbox "Email address"');
    expect(snapshot).toContain('button "Subscribe"');
  });

  it('traverses slotted content without duplicating it', () => {
    document.body.innerHTML = '<my-card><span>Slotted text</span></my-card>';
    const shadow = document.querySelector('my-card')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<article><h3>Card</h3><slot></slot></article>';
    const snapshot = captureAriaSnapshot(document).snapshot;
    expect(snapshot).toContain('Slotted text');
    // Visiting both the light-DOM child and the <slot> would print it twice.
    expect(snapshot.match(/Slotted text/g)).toHaveLength(1);
  });

  it('falls back to slot default content when nothing is assigned', () => {
    document.body.innerHTML = '<my-card></my-card>';
    const shadow = document.querySelector('my-card')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<slot><em>Default</em></slot>';
    expect(captureAriaSnapshot(document).snapshot).toContain('Default');
  });

  it('hoists children of a presentational element', () => {
    const snapshot = snapshotOf('<ul role="presentation"><li role="none"><a href="/x">Link</a></li></ul>');
    expect(snapshot).not.toContain('list');
    expect(snapshot).toContain('link "Link"');
  });
});

describe('aria snapshot: distiller', () => {
  it('unwraps deeply nested single-child generics', () => {
    let html = '<h1>Buried headline</h1><button>Buy now</button>';
    for (let i = 0; i < 18; i++) html = `<div class="wrapper-${i}">${html}</div>`;
    const snapshot = snapshotOf(html);

    // Defect B: `maxDepth: 8` lost both of these silently.
    expect(snapshot).toContain('heading "Buried headline"');
    expect(snapshot).toContain('button "Buy now"');
    // And the 18 wrappers must actually be gone, not merely traversed.
    expect(snapshot.split('\n').length).toBeLessThan(5);
  });

  it('collapses a chain of wrappers around a single text node', () => {
    const snapshot = snapshotOf('<div><div><div><div>Just text</div></div></div></div>');
    expect(snapshot).toContain('Just text');
    expect(snapshot.split('\n')).toHaveLength(1);
  });

  it('drops decorative images with no accessible name', () => {
    const snapshot = snapshotOf('<p>Body</p><img src="/spacer.gif" alt=""><img src="/tracker.gif">');
    expect(snapshot).not.toContain('img');
  });

  it('keeps a nameless image that is itself the click target', () => {
    // An icon-only link must survive: it is the thing the agent has to click.
    const snapshot = snapshotOf('<a href="/" aria-label="Acme home"><img src="/logo.svg" alt=""></a>');
    expect(snapshot).toContain('link "Acme home"');
    expect(snapshot).toContain('/url: /');
  });

  it('removes a child that merely repeats the parent name', () => {
    const snapshot = snapshotOf('<a href="/docs"><span>Docs</span></a>');
    // `link "Docs"` already says it; a nested `text: Docs` is pure duplication.
    expect(snapshot).toContain('link "Docs"');
    expect(snapshot.match(/Docs/g)?.length).toBeLessThanOrEqual(2); // name + url
  });

  it('inlines text through a nameless generic chain', () => {
    const snapshot = snapshotOf('<div><div>Inlined</div></div>');
    expect(snapshot.split('\n')).toHaveLength(1);
    expect(snapshot).toContain('Inlined');
  });

  it('keeps a wrapper that carries state or a name', () => {
    const snapshot = snapshotOf('<div role="region" aria-label="Kept"><p>x</p></div>');
    expect(snapshot).toContain('region "Kept"');
  });

  it('merges adjacent text children and normalises whitespace', () => {
    const snapshot = snapshotOf('<p>Some    text\n\n   with gaps</p>');
    expect(snapshot).toContain('Some text with gaps');
  });

  it('keeps text that a content-derived name is built from', () => {
    const snapshot = snapshotOf('<h2>Segment <em>performance</em></h2>');
    // The heading name and the emphasised span must both survive: clearing the
    // name is only valid when the children still spell it out.
    expect(snapshot).toContain('Segment');
    expect(snapshot).toContain('performance');
  });
});

describe('aria snapshot: refs', () => {
  it('assigns refs only to interactable elements', () => {
    const snapshot = snapshotOf('<h1>Title</h1><p>Prose</p><button>Act</button><a href="/x">Go</a>');
    expect(snapshot).toMatch(/button "Act" \[ref=e\d+\]/);
    expect(snapshot).toMatch(/link "Go" \[ref=e\d+\]/);
    // A ref on a heading is a ref the agent can never use.
    expect(snapshot).not.toMatch(/heading "Title" \[ref=/);
    expect(snapshot).not.toMatch(/paragraph.*\[ref=/);
  });

  it('assigns refs to elements made interactive by attributes', () => {
    const snapshot = snapshotOf('<div tabindex="0" aria-label="Custom control">x</div>');
    expect(snapshot).toMatch(/\[ref=e\d+\]/);
  });

  it('keeps refs stable across two snapshots of an unchanged page', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    const first = captureAriaSnapshot(document).snapshot;
    const second = captureAriaSnapshot(document).snapshot;
    expect(second).toBe(first);
  });

  it('does not assign a ref inside a pointer-events:none subtree', () => {
    const snapshot = snapshotOf('<div style="pointer-events:none"><button>Unclickable</button></div>');
    expect(snapshot).toContain('button "Unclickable"');
    expect(snapshot).not.toMatch(/Unclickable" \[ref=/);
  });

  it('counts the refs it handed out', () => {
    document.body.innerHTML = '<button>a</button><button>b</button><p>not interactive</p>';
    expect(captureAriaSnapshot(document).refCount).toBe(2);
  });
});

describe('aria snapshot: options', () => {
  it('scopes the snapshot to a root element', () => {
    document.body.innerHTML = '<nav><a href="/">Home</a></nav><main><h1>Scoped</h1></main>';
    const snapshot = captureAriaSnapshot(document, {
      root: document.querySelector('main')!,
    }).snapshot;
    expect(snapshot).toContain('Scoped');
    expect(snapshot).not.toContain('Home');
  });

  it('keeps only actionable elements under interactiveOnly', () => {
    document.body.innerHTML = '<article><h1>Headline</h1><p>Prose</p><button>Act</button></article>';
    const snapshot = captureAriaSnapshot(document, { interactiveOnly: true }).snapshot;
    expect(snapshot).toContain('button "Act"');
    expect(snapshot).not.toContain('Prose');
    expect(snapshot).not.toContain('Headline');
  });

  it('truncates rendering at depth without affecting discovery', () => {
    document.body.innerHTML = `
      <main><section aria-label="Outer"><ul><li><a href="/deep">Deep link</a></li></ul></section></main>
    `;
    const full = captureAriaSnapshot(document);
    expect(full.snapshot).toContain('Deep link');

    const shallow = captureAriaSnapshot(document, { depth: 1 });
    expect(shallow.snapshot).not.toContain('Deep link');
    // Discovery is unaffected: the element still got a ref, unlike the old
    // `maxDepth`, which skipped the subtree entirely.
    expect(shallow.refCount).toBe(full.refCount);
    expect(shallow.snapshot).toContain('…');
  });
});

describe('aria snapshot: golden fixtures', () => {
  it('captures every structural marker on the article fixture', () => {
    loadFixture('article-page.html');
    const snapshot = captureAriaSnapshot(document).snapshot;

    expect(snapshot).toContain('heading "Acme Corp Reports Record Q3 Revenue" [level=1]');
    expect(snapshot).toContain('/url: /authors/jane');
    expect(snapshot).toContain('img "Acme Corp headquarters at sunset"');
    expect(snapshot).toContain('columnheader "Segment"');
    expect(snapshot).toContain('cell "AcmeCloud"');
    expect(snapshot).toContain('button "Post comment" [disabled]');
    expect(snapshot).toContain('/placeholder: Share your thoughts');

    // Noise that the old snapshot let through.
    expect(snapshot).not.toContain('"props"');
    expect(snapshot).not.toContain('Hydration');
    expect(snapshot).not.toContain('Ghost button');
    expect(snapshot).not.toContain('NewsProducts');
  });

  it('keeps deep content on the deep-nested fixture', () => {
    loadFixture('deep-nested.html');
    const snapshot = captureAriaSnapshot(document).snapshot;
    expect(snapshot).toContain('Buried headline');
    expect(snapshot).toContain('button "Buy now"');
    expect(snapshot).toContain('Deeply nested prose that must not disappear.');
    // 18 wrappers in, a handful of lines out.
    expect(snapshot.split('\n').length).toBeLessThan(6);
  });

  it('collapses the tree itself, not just its rendering', () => {
    loadFixture('deep-nested.html');
    const raw = buildAriaTree(document, { assignRefs: false });
    const rawDepth = treeDepth(raw);
    const distilledDepth = treeDepth(distill(buildAriaTree(document, { assignRefs: false })));

    // The traversal keeps all 18 wrappers, so the collapse is provably the
    // distiller's work. Measuring the rendered text instead would prove nothing:
    // the renderer independently omits nameless generics, so the raw tree already
    // *prints* flat while still being deep.
    expect(rawDepth).toBeGreaterThan(15);
    expect(distilledDepth).toBeLessThan(4);
  });
});

/** Longest root-to-leaf path in an aria tree, counting element nodes only. */
function treeDepth(node: AriaNode): number {
  const childDepths = node.children
    .filter((child): child is AriaNode => typeof child !== 'string')
    .map((child) => treeDepth(child));
  return 1 + (childDepths.length ? Math.max(...childDepths) : 0);
}

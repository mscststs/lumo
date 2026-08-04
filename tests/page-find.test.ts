/**
 * @vitest-environment jsdom
 *
 * `page_find`: locate a node without paying for the whole tree.
 *
 * A 400-item list snapshots to ~57k characters (research.md §3). Search exists so
 * that finding one button on such a page costs a few lines instead of the whole
 * budget, which is the same reason playwright-mcp added `browser_find`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { findInAriaTree } from '@/lib/page/find';
import { captureAriaSnapshot } from '@/lib/page/aria-snapshot';
import { resetRefRegistry } from '@/lib/page/ref-registry';

function bigList(items: number): void {
  document.body.innerHTML = `
    <main>
      <h1>Inventory</h1>
      <ul>${Array.from(
        { length: items },
        (_, i) => `<li><span>Widget ${i}</span><button>Add ${i} to cart</button></li>`,
      ).join('')}</ul>
    </main>
  `;
}

function find(options: Parameters<typeof findInAriaTree>[1]) {
  const result = findInAriaTree(document, options);
  if ('error' in result) throw new Error(result.error);
  return result;
}

beforeEach(() => {
  resetRefRegistry();
  document.body.innerHTML = '';
});

describe('findInAriaTree', () => {
  it('returns only the matching node, not the whole tree', () => {
    bigList(400);
    const whole = captureAriaSnapshot(document).snapshot;
    const result = find({ text: 'Add 137 to cart' });

    expect(result.matches).toHaveLength(1);
    const rendered = result.matches[0]!.lines.join('\n');
    expect(rendered).toContain('Add 137 to cart');
    // The entire point: a fraction of the cost of a full snapshot.
    expect(rendered.length).toBeLessThan(whole.length / 100);
  });

  it('reports the path from the root so the match is locatable', () => {
    bigList(5);
    const [match] = find({ text: 'Add 3 to cart' }).matches;
    expect(match!.path).toContain('main');
    expect(match!.path).toContain('list');
  });

  it('returns the ref an agent needs to act on the match', () => {
    bigList(5);
    const [match] = find({ text: 'Add 3 to cart' }).matches;
    expect(match!.ref).toMatch(/^e\d+$/);
  });

  it('matches case-insensitively on text', () => {
    document.body.innerHTML = '<button>Submit Order</button>';
    expect(find({ text: 'submit order' }).matches).toHaveLength(1);
  });

  it('matches on a regex', () => {
    document.body.innerHTML = '<p>Error: code 500</p><p>All good</p>';
    const result = find({ regex: 'code \\d+' });
    expect(result.totalMatches).toBe(1);
  });

  it('accepts a slash-wrapped regex with flags', () => {
    document.body.innerHTML = '<p>ERROR: failed</p>';
    expect(find({ regex: '/error/i' }).totalMatches).toBe(1);
    expect(find({ regex: '/error/' }).totalMatches).toBe(0);
  });

  it('searches link urls as well as names', () => {
    document.body.innerHTML = '<a href="/ir/filings/q3.pdf">Download</a>';
    expect(find({ text: 'q3.pdf' }).matches).toHaveLength(1);
  });

  it('searches roles so structural queries work', () => {
    document.body.innerHTML = '<table><tr><td>x</td></tr></table>';
    expect(find({ text: 'columnheader' }).totalMatches).toBe(0);
    expect(find({ text: 'cell' }).totalMatches).toBeGreaterThan(0);
  });

  it('counts every match but returns at most the limit', () => {
    bigList(50);
    const result = find({ text: 'to cart', limit: 5 });
    expect(result.matches).toHaveLength(5);
    // The count is the signal that a narrower query is needed.
    expect(result.totalMatches).toBe(50);
  });

  it('renders context depth under each match', () => {
    document.body.innerHTML = `
      <section aria-label="Cart"><ul><li><span>Deep</span><button>Remove</button></li></ul></section>
    `;
    const shallow = find({ text: 'Cart', context: 1 }).matches[0]!;
    const deep = find({ text: 'Cart', context: 5 }).matches[0]!;
    expect(deep.lines.length).toBeGreaterThan(shallow.lines.length);
    expect(deep.lines.join('\n')).toContain('Remove');
  });

  it('returns no matches rather than failing when nothing matches', () => {
    document.body.innerHTML = '<p>Nothing here</p>';
    const result = find({ text: 'absent' });
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(0);
  });

  it('rejects a query with both text and regex', () => {
    document.body.innerHTML = '<p>x</p>';
    expect(findInAriaTree(document, { text: 'a', regex: 'b' })).toEqual({
      error: 'Provide either text or regex, not both',
    });
  });

  it('rejects an empty query', () => {
    document.body.innerHTML = '<p>x</p>';
    expect(findInAriaTree(document, {})).toEqual({
      error: 'Provide text or regex to search for',
    });
  });

  it('reports an invalid regex instead of throwing', () => {
    document.body.innerHTML = '<p>x</p>';
    const result = findInAriaTree(document, { regex: '([unclosed' });
    expect('error' in result && result.error).toMatch(/Invalid regex/);
  });

  it('does not report nested duplicates of the same match', () => {
    // A match's children are already returned as its context, so descending into
    // it would report the same hit several times at different depths.
    document.body.innerHTML = '<div role="region" aria-label="Alpha"><p>Alpha</p></div>';
    expect(find({ text: 'Alpha' }).totalMatches).toBe(1);
  });
});

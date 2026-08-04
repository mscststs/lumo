/**
 * @vitest-environment jsdom
 *
 * Ref registry contract — the highest-priority tests in this change.
 *
 * A CSS path like `li:nth-of-type(6) > button` starts pointing at a *different*
 * element the moment a sibling is inserted, and the click goes through with no
 * error (spec research §4: "SILENTLY CLICKS WRONG ELEMENT"). Every test here
 * exists to pin down that a ref cannot do that.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { refFor, resolveRef, pruneRefs, refCount, resetRefRegistry } from '@/lib/page/ref-registry';

function list(items: number): HTMLUListElement {
  document.body.innerHTML = `
    <ul id="list">
      ${Array.from({ length: items }, (_, i) => `<li><div><button>Add ${i}</button></div></li>`).join('')}
    </ul>
  `;
  return document.getElementById('list') as HTMLUListElement;
}

describe('ref registry', () => {
  beforeEach(() => {
    resetRefRegistry();
    document.body.innerHTML = '';
  });

  it('returns a stable ref for the same element across calls', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    const button = document.getElementById('b')!;
    expect(refFor(button)).toBe(refFor(button));
  });

  it('keeps refs pointing at the same element after a sibling is inserted', () => {
    const ul = list(6);
    const target = ul.querySelectorAll('button')[5]!;
    expect(target.textContent).toBe('Add 5');

    const ref = refFor(target);

    // Simulate the SPA live-update that breaks positional selectors.
    const inserted = document.createElement('li');
    inserted.innerHTML = '<div><button>Add new</button></div>';
    ul.prepend(inserted);

    expect(resolveRef(ref)?.textContent).toBe('Add 5');
  });

  it('exposes the positional-selector defect as an explicit counter-example', () => {
    const ul = list(6);
    const target = ul.querySelectorAll('button')[5]!;
    expect(target.textContent).toBe('Add 5');

    const ref = refFor(target);

    const inserted = document.createElement('li');
    inserted.innerHTML = '<div><button>Add new</button></div>';
    ul.prepend(inserted);

    // The CSS path an agent would have recorded is only evaluated *after* the
    // mutation, which is exactly the situation it gets used in. jsdom's selector
    // engine memoises per query string, so querying before the mutation would
    // return a stale cached node and hide the defect rather than demonstrate it.
    const path = '#list > li:nth-of-type(6) > div > button';
    expect(document.querySelector(path)?.textContent).toBe('Add 4');

    // The ref still holds identity. If anyone reimplements refs as paths, this
    // assertion is what fails.
    expect(resolveRef(ref)?.textContent).toBe('Add 5');
  });

  it('resolves to undefined once the element is detached', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    const button = document.getElementById('b')!;
    const ref = refFor(button);
    expect(resolveRef(ref)).toBe(button);

    button.remove();

    // Explicit invalidation is the precondition for failing loudly instead of
    // acting on a stale node.
    expect(resolveRef(ref)).toBeUndefined();
  });

  it('resolves to undefined for a ref that was never issued', () => {
    expect(resolveRef('e9999')).toBeUndefined();
  });

  it('allocates distinct refs for distinct elements', () => {
    document.body.innerHTML = '<button>a</button><button>b</button>';
    const [a, b] = Array.from(document.querySelectorAll('button'));
    expect(refFor(a!)).not.toBe(refFor(b!));
  });

  it('prunes tombstones without invalidating live refs', () => {
    const ul = list(3);
    const buttons = Array.from(ul.querySelectorAll('button'));
    const refs = buttons.map((button) => refFor(button));
    expect(refCount()).toBe(3);

    pruneRefs();

    // Nothing was collected, so every ref must survive a prune.
    expect(refCount()).toBe(3);
    for (const [index, ref] of refs.entries()) {
      expect(resolveRef(ref)?.textContent).toBe(`Add ${index}`);
    }
  });

  it('keeps other refs valid when one element is removed', () => {
    const ul = list(3);
    const buttons = Array.from(ul.querySelectorAll('button'));
    const refs = buttons.map((button) => refFor(button));

    buttons[1]!.remove();

    expect(resolveRef(refs[0]!)?.textContent).toBe('Add 0');
    expect(resolveRef(refs[1]!)).toBeUndefined();
    expect(resolveRef(refs[2]!)?.textContent).toBe('Add 2');
  });

  it('reissues the same ref when a detached element is re-attached', () => {
    document.body.innerHTML = '<div id="host"><button id="b">Go</button></div>';
    const button = document.getElementById('b')!;
    const ref = refFor(button);
    button.remove();
    expect(resolveRef(ref)).toBeUndefined();

    document.getElementById('host')!.append(button);

    // Identity is the element, not its position, so re-attaching restores it.
    expect(resolveRef(ref)).toBe(button);
    expect(refFor(button)).toBe(ref);
  });
});

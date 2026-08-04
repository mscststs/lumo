/**
 * @vitest-environment jsdom
 *
 * Timing tests for defect C: the failure only exists *between* two calls.
 *
 * Any single-call test passes whether refs are identities or paths. What has to
 * be pinned down is the three-step sequence an agent actually performs —
 * snapshot, the DOM changes underneath it, then act — because that is where the
 * old positional selectors silently retarget a neighbour.
 *
 * These go through `handlePageRequest` rather than the registry directly, so the
 * assertion covers the whole path the tool takes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { handlePageRequest } from '@/lib/page/handlers';
import { resetRefRegistry } from '@/lib/page/ref-registry';
import type { PageActResponse, PageSnapshotResponse } from '@/lib/page/messages';

async function snapshot(): Promise<PageSnapshotResponse> {
  const response = await handlePageRequest({
    type: 'lumo:page:snapshot',
    interactiveOnly: false,
  });
  if (!response.ok) throw new Error(`snapshot failed: ${response.error}`);
  return response as PageSnapshotResponse;
}

/** Pull the ref that a model would read off a snapshot line. */
function refForLabel(snapshotText: string, label: string): string {
  const line = snapshotText
    .split('\n')
    .find((candidate) => candidate.includes(`"${label}"`) && candidate.includes('[ref='));
  if (!line) throw new Error(`No ref'd line for "${label}" in:\n${snapshotText}`);
  return /\[ref=(e\d+)\]/.exec(line)![1]!;
}

function liveList(items: number): HTMLUListElement {
  document.body.innerHTML = `<ul id="list">${Array.from(
    { length: items },
    (_, i) => `<li><div><button>Add ${i}</button></div></li>`,
  ).join('')}</ul>`;
  return document.getElementById('list') as HTMLUListElement;
}

describe('snapshot → mutate → act', () => {
  beforeEach(() => {
    resetRefRegistry();
    document.body.innerHTML = '';
  });

  it('acts on the originally identified element after a prepend', async () => {
    const ul = liveList(6);
    const { snapshot: tree } = await snapshot();
    const ref = refForLabel(tree, 'Add 5');

    let clicked: string | undefined;
    ul.addEventListener('click', (event) => {
      clicked = (event.target as HTMLElement).textContent ?? undefined;
    });

    // The SPA updates between the two calls — the whole point of the scenario.
    const inserted = document.createElement('li');
    inserted.innerHTML = '<div><button>Add new</button></div>';
    ul.prepend(inserted);

    const result = await handlePageRequest({ type: 'lumo:page:act', action: 'click', ref });
    expect(result.ok).toBe(true);
    expect((result as PageActResponse).element.text).toBe('Add 5');
    expect(clicked).toBe('Add 5');

    // Counter-example: the positional path an agent would otherwise have used
    // now points at the neighbour, and clicking it would raise no error.
    expect(document.querySelector('#list > li:nth-of-type(6) > div > button')?.textContent)
      .toBe('Add 4');
  });

  it('fails loudly when the target was removed', async () => {
    document.body.innerHTML = '<div id="modal"><button>Confirm</button></div>';
    const { snapshot: tree } = await snapshot();
    const ref = refForLabel(tree, 'Confirm');

    document.getElementById('modal')!.remove();

    const result = await handlePageRequest({ type: 'lumo:page:act', action: 'click', ref });
    expect(result.ok).toBe(false);
    // The message must tell the model what to do next, not just that it failed.
    expect(result.ok === false && result.error).toMatch(/no longer on the page/);
    expect(result.ok === false && result.error).toMatch(/page_snapshot/);
  });

  it('keeps other refs valid when one element is removed', async () => {
    const ul = liveList(3);
    const { snapshot: tree } = await snapshot();
    const refs = [0, 1, 2].map((i) => refForLabel(tree, `Add ${i}`));

    ul.children[1]!.remove();

    const first = await handlePageRequest({ type: 'lumo:page:act', action: 'click', ref: refs[0]! });
    const second = await handlePageRequest({ type: 'lumo:page:act', action: 'click', ref: refs[1]! });
    const third = await handlePageRequest({ type: 'lumo:page:act', action: 'click', ref: refs[2]! });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(true);
  });

  it('keeps refs stable across two snapshots of an unchanged page', async () => {
    liveList(4);
    const first = await snapshot();
    const second = await snapshot();
    expect(second.snapshot).toBe(first.snapshot);
  });

  it('keeps existing refs while assigning new ones to inserted elements', async () => {
    const ul = liveList(2);
    const before = await snapshot();
    const stableRef = refForLabel(before.snapshot, 'Add 1');

    const inserted = document.createElement('li');
    inserted.innerHTML = '<div><button>Add new</button></div>';
    ul.append(inserted);

    const after = await snapshot();
    expect(refForLabel(after.snapshot, 'Add 1')).toBe(stableRef);
    expect(refForLabel(after.snapshot, 'Add new')).not.toBe(stableRef);
  });

  it('fills a ref\'d input and reports the value back', async () => {
    document.body.innerHTML = '<label for="e">Email</label><input id="e" type="email">';
    const { snapshot: tree } = await snapshot();
    const ref = refForLabel(tree, 'Email');

    const result = await handlePageRequest({
      type: 'lumo:page:act',
      action: 'fill',
      ref,
      value: 'a@b.com',
    });
    expect(result.ok).toBe(true);
    expect((document.getElementById('e') as HTMLInputElement).value).toBe('a@b.com');
  });

  it('rejects an action whose element is the wrong kind', async () => {
    document.body.innerHTML = '<button>Go</button>';
    const { snapshot: tree } = await snapshot();
    const ref = refForLabel(tree, 'Go');

    const result = await handlePageRequest({
      type: 'lumo:page:act',
      action: 'select-option',
      ref,
      value: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not a select/);
  });
});

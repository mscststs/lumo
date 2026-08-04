/**
 * Element identity registry for snapshot refs.
 *
 * Refs must survive DOM mutations: a CSS path like `li:nth-of-type(6) > button`
 * silently points at a *different* element once a sibling is inserted, which
 * makes the agent click the wrong thing with no error (see spec research §4).
 *
 * Playwright solves this by stashing the ref on the element itself
 * (`element._ariaRef`). We use a WeakMap instead so the page's own objects are
 * never touched, plus a WeakRef reverse index so a detached element resolves to
 * `undefined` and the tool can fail loudly instead of acting on a stale node.
 */

const refOf = new WeakMap<Element, string>();
const byRef = new Map<string, WeakRef<Element>>();
let counter = 0;

/**
 * Return the element's stable ref, allocating one on first sight.
 * Re-snapshotting an unchanged page therefore yields identical refs.
 */
export function refFor(element: Element): string {
  const existing = refOf.get(element);
  if (existing) return existing;
  const ref = `e${++counter}`;
  refOf.set(element, ref);
  byRef.set(ref, new WeakRef(element));
  return ref;
}

/** Resolve a ref, or `undefined` when the element is gone / never existed. */
export function resolveRef(ref: string): Element | undefined {
  const element = byRef.get(ref)?.deref();
  if (!element) {
    byRef.delete(ref); // GC'd — drop the tombstone
    return undefined;
  }
  // A detached element is as unusable as a collected one.
  if (!element.isConnected) return undefined;
  return element;
}

/**
 * Drop tombstones for collected elements. Called after each snapshot so the map
 * does not grow without bound on long-lived SPA tabs.
 */
export function pruneRefs(): void {
  for (const [ref, weak] of byRef) {
    if (!weak.deref()) byRef.delete(ref);
  }
}

/** Number of refs currently tracked (live or awaiting prune). Test helper. */
export function refCount(): number {
  return byRef.size;
}

/**
 * Wipe the registry. Only used by tests — a real page keeps its refs for the
 * lifetime of the document so that a ref handed to the model stays resolvable.
 */
export function resetRefRegistry(): void {
  byRef.clear();
  counter = 0;
}

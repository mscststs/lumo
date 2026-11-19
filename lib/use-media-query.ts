import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query and returns its value.
 *
 * This is for the decisions that are *structural* rather than cosmetic — where
 * the breakpoint changes the DOM (wrapping a control in a disclosure, swapping
 * a label for an icon) instead of only its paint. Anything that can be
 * expressed as a `lg:` variant stays in CSS; a component that needs to know
 * "am I an icon rail right now?" cannot ask Tailwind.
 *
 * `rem` in the query tracks the root font size, exactly like the `lg:` variants
 * it mirrors, so a user who scales the UI up collapses the layout at the same
 * point as the rule that hides the labels.
 *
 * @param query A media query string, e.g. `(width < 64rem)`.
 * @param fallback Value used when `matchMedia` is missing (jsdom, SSR).
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToQuery(query, onStoreChange),
    [query],
  );
  const getSnapshot = useCallback(() => matchesQuery(query) ?? fallback, [query, fallback]);

  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}

function queryList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia(query);
}

function matchesQuery(query: string): boolean | null {
  return queryList(query)?.matches ?? null;
}

function subscribeToQuery(query: string, onStoreChange: () => void): () => void {
  const list = queryList(query);
  if (!list) return () => {};

  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onStoreChange);
    return () => list.removeEventListener('change', onStoreChange);
  }

  // Safari < 14 only implements the deprecated pair. Kept because the options
  // page runs in whatever browser the user has, not only in Chrome.
  list.addListener(onStoreChange);
  return () => list.removeListener(onStoreChange);
}

import { useSyncExternalStore } from 'react';

/**
 * A minute-resolution clock shared by every message timestamp.
 *
 * Relative labels ("3 minutes ago") are computed once and then sit in the DOM.
 * Without a tick they silently age: a panel left open overnight still claims
 * "3 minutes ago" under a reply from yesterday.
 *
 * The subscription lives at module scope on purpose — one `setInterval` for the
 * whole transcript instead of one per `<time>`, started on the first subscriber
 * and cleared when the last one unmounts. `useSyncExternalStore` re-renders the
 * timestamps (and nothing above them) when the minute changes.
 */

const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

function tick(): void {
  const next = Date.now();
  // Strict equality is enough: a tick that does not move the clock forward has
  // nothing new to show, and skipping the notification avoids a pointless
  // render of every message.
  if (next === now) return;
  now = next;
  for (const notify of subscribers) notify();
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  if (timer === null) {
    timer = setInterval(tick, TICK_MS);
  }
  // The store may have been idle since the last subscriber left, so refresh
  // before the first read rather than waiting up to a minute for a stale label.
  tick();
  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return now;
}

/** Current time in milliseconds, re-read at most once a minute. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

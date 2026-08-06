/**
 * Consumes quick actions the background left in `chrome.storage.session`.
 *
 * Two paths must both work, which is why the payload goes through storage
 * rather than `chrome.runtime.sendMessage`:
 * - Cold open: the panel was closed when the menu was clicked, so the payload
 *   was already written by the time we mount and must be read on mount.
 * - Warm: the panel was open, so the write arrives as a storage change event.
 *
 * Both funnel into one callback, deduplicated by timestamp so a payload is never
 * applied twice when the two paths overlap.
 */

import { useEffect, useRef } from 'react';
import { CONTEXT_MENU_PENDING_KEY, type ContextMenuPendingData } from '@/lib/context-menu';

/**
 * How long a pending action stays valid. A payload older than this was left by a
 * click the user has since abandoned (they closed the panel, walked away, then
 * reopened it), and firing it then would be a surprise.
 */
const PENDING_TTL_MS = 30_000;

export interface UseContextMenuPendingOptions {
  /**
   * Whether the consumer is ready to route an action.
   *
   * On a cold open the panel mounts long before it knows how many chat panels it
   * should show — that count is an async storage read — so dispatching on the
   * next animation frame (the previous behaviour) could route to panel 0 while
   * panel 1 was still on its way, ignoring the user's split layout. Gating on an
   * explicit signal replaces that guess about timing with a fact.
   *
   * Defaults to ready, for consumers with nothing to wait for.
   */
  isReady?: boolean;
}

export function useContextMenuPending(
  onPending: (pending: ContextMenuPendingData) => void,
  options?: UseContextMenuPendingOptions,
) {
  const isReady = options?.isReady ?? true;

  // Held in a ref so a changing callback identity cannot re-run the effect and
  // re-consume a payload.
  const onPendingRef = useRef(onPending);
  onPendingRef.current = onPending;

  const lastTimestampRef = useRef(0);
  /** Payload that arrived before the consumer was ready. */
  const heldRef = useRef<ContextMenuPendingData | null>(null);
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  useEffect(() => {
    const deliver = (pending: ContextMenuPendingData) => {
      if (pending.timestamp <= lastTimestampRef.current) return;
      lastTimestampRef.current = pending.timestamp;
      onPendingRef.current(pending);
      // Clear so it is not re-applied the next time the panel opens.
      void chrome.storage.session.remove(CONTEXT_MENU_PENDING_KEY);
    };

    const consume = (pending: ContextMenuPendingData) => {
      if (!isReadyRef.current) {
        // Last one wins; a newer click supersedes a held one.
        heldRef.current = pending;
        return;
      }
      deliver(pending);
    };

    const consumeOnMount = async () => {
      try {
        const result = await chrome.storage.session.get(CONTEXT_MENU_PENDING_KEY);
        const pending = result[CONTEXT_MENU_PENDING_KEY] as ContextMenuPendingData | undefined;
        if (pending && Date.now() - pending.timestamp < PENDING_TTL_MS) {
          consume(pending);
        }
      } catch {
        // Session storage unavailable: nothing to consume.
      }
    };

    void consumeOnMount();

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      const pending = changes[CONTEXT_MENU_PENDING_KEY]?.newValue as
        | ContextMenuPendingData
        | undefined;
      if (pending) consume(pending);
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
    // `isReady` is read through a ref, so becoming ready must not re-run this
    // effect (which would re-read and re-consume). The release is handled below.
  }, []);

  // Release a held payload once the consumer becomes ready.
  useEffect(() => {
    if (!isReady) return;
    const held = heldRef.current;
    if (!held) return;
    heldRef.current = null;
    if (held.timestamp <= lastTimestampRef.current) return;
    lastTimestampRef.current = held.timestamp;
    onPendingRef.current(held);
    void chrome.storage.session.remove(CONTEXT_MENU_PENDING_KEY);
  }, [isReady]);
}

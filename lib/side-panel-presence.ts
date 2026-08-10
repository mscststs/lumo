/**
 * Whether a side panel is open *right now*, for pages whose actions only make
 * sense when one is.
 *
 * The options page file list is dragged into the side panel, so that gesture has
 * a precondition the page cannot otherwise see: with no panel to drop on, the
 * drag ends nowhere and the user is left guessing whether the feature works.
 *
 * `splitViewVisible` in storage looks like the answer and is not — it records the
 * layout the side panel last published and outlives the panel being closed, so it
 * describes a past arrangement rather than present liveness. The event bus is no
 * answer either: it is documented as unacknowledged notification, so a page that
 * mounts while the panel is already open would never hear about it.
 * `chrome.runtime.getContexts` asks the browser directly, which is the only
 * source that is true at the moment it is read.
 *
 * ## Unknown is not closed
 *
 * `getContexts` needs Chrome 116, and a query can fail. Callers get `null` for
 * that case and must treat it as permission, never as refusal: gating a gesture
 * on a failed probe would remove a working feature on the browsers least able to
 * report why. Only a definite `false` should turn anything off.
 */

import { useCallback, useEffect, useState } from 'react';
import { onEvent } from '@/lib/event-bus';

/** `true` open, `false` closed, `null` unknown — see "Unknown is not closed". */
export type SidePanelPresence = boolean | null;

/**
 * Asks the browser whether any side panel document is alive.
 *
 * Deliberately not scoped to the current window. A panel in another window is
 * still a valid drop target (Chrome allows dragging between windows), and being
 * wrong in the permissive direction only leaves an affordance offered, while being
 * wrong the other way disables a gesture that would have worked.
 */
export async function querySidePanelPresence(): Promise<SidePanelPresence> {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime?.getContexts) return null;
  try {
    const contexts = await runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return contexts.length > 0;
  } catch {
    return null;
  }
}

/**
 * Tracks side panel presence.
 *
 * Two complementary sources keep it as close to real time as the browser allows:
 *
 * - The side panel itself announces `sidepanel:opened` / `sidepanel:closed` as it
 *   mounts and is unloaded, so a change is recognised the moment it happens
 *   rather than on the next focus event. This is what makes open/close
 *   recognisable while the reading page is not focused.
 * - The authoritative answer still comes from `getContexts`, which counts every
 *   window. The events are only *triggers* to re-read it, never the value
 *   itself: a boolean flip would be wrong when two windows have panels open and
 *   one closes, and a fire-and-forget event can be missed (a panel opened before
 *   this page mounted, or a close whose `pagehide` broadcast was swallowed).
 */
export function useSidePanelPresence(): SidePanelPresence {
  const [isOpen, setIsOpen] = useState<SidePanelPresence>(null);

  const refresh = useCallback(() => {
    void querySidePanelPresence().then(setIsOpen);
  }, []);

  useEffect(() => {
    refresh();

    // Events re-probe rather than set the state directly, so the value always
    // reflects what `getContexts` reports across every window.
    const offOpened = onEvent('sidepanel:opened', refresh);
    const offClosed = onEvent('sidepanel:closed', refresh);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      offOpened();
      offClosed();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  return isOpen;
}

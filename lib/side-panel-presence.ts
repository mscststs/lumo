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
 * Re-read when this tab is focused or becomes visible, which is precisely when
 * the answer can have changed without this page being told: opening or closing a
 * side panel moves focus away from the tab, so coming back to it is the event
 * worth listening to. A timer was the alternative and is not worth it — nothing
 * here is time-critical, and the app deliberately keeps no polling loops.
 */
export function useSidePanelPresence(): SidePanelPresence {
  const [isOpen, setIsOpen] = useState<SidePanelPresence>(null);

  const refresh = useCallback(() => {
    void querySidePanelPresence().then(setIsOpen);
  }, []);

  useEffect(() => {
    refresh();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  return isOpen;
}

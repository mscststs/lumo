/**
 * Panel routing for quick actions.
 *
 * When a quick action arrives from the right-click menu we must pick which chat
 * panel handles it, and whether to send immediately or leave the prompt in the
 * input for the user to edit. The policy, in priority order:
 *
 * 1. Prefer a panel that is idle (not streaming) **and** has an empty input —
 *    that one can be sent without destroying anything. Rightmost first, since the
 *    rightmost panel is the primary one the user's eye is on.
 * 2. Otherwise we must prefill. Prefer a panel with an empty input even if it is
 *    streaming: dropping the prompt into empty space costs the user nothing,
 *    whereas landing on a draft forces them to disentangle two texts.
 * 3. Otherwise every input holds a draft: fall back to the rightmost panel. It
 *    always exists.
 *
 * "Rightmost first" is ascending **logical index**, not ascending slot. The two
 * used to be the same thing, but panels can now be reordered, so a panel's slot
 * says where its data lives while its logical index says where it sits (see
 * `panel-order.ts`). Routing is about what the user is looking at, so it must
 * follow position — otherwise dragging a panel would silently change which one
 * the context menu talks to.
 *
 * Only auto-sendable actions can reach outcome `send`; an action with no prompt
 * has nothing to send and is always a prefill.
 */

export interface PanelRoutingState {
  /** Storage slot — the panel's identity, and what the caller routes back to. */
  slot: number;
  /**
   * Position from the right: 0 is the primary (rightmost) panel.
   *
   * Derived from the panel order rather than from `slot`, so a reordered layout
   * routes to the panel the user actually sees on the right.
   */
  logicalIndex: number;
  /** The panel is mid-stream and cannot accept a send. */
  isStreaming: boolean;
  /** The panel's input already holds text or attachments. */
  hasContent: boolean;
}

export type QuickActionDelivery = 'send' | 'prefill';

export interface QuickActionRoute {
  /**
   * The chosen panel's slot, or `undefined` when there were no panels to choose
   * from. The caller decides the fallback, since only it knows which panels have
   * actually mounted.
   */
  slot: number | undefined;
  delivery: QuickActionDelivery;
}

/**
 * Chooses the panel and delivery mode for a quick action.
 *
 * @param panels One entry per *visible* panel, in any order.
 * @param canAutoSend Whether the action carries a prompt that may be sent
 *   without user confirmation.
 */
export function routeQuickAction(
  panels: readonly PanelRoutingState[],
  canAutoSend: boolean,
): QuickActionRoute {
  // Rightmost first: the rightmost panel is the primary one, so ascending
  // logical index is the preference order in every tier below. Ties break on
  // slot to keep the outcome deterministic.
  const ordered = [...panels].sort(
    (a, b) => a.logicalIndex - b.logicalIndex || a.slot - b.slot,
  );

  if (canAutoSend) {
    const sendable = ordered.find((panel) => !panel.isStreaming && !panel.hasContent);
    if (sendable) {
      return { slot: sendable.slot, delivery: 'send' };
    }
  }

  // Nothing can be sent cleanly, so this is a prefill. Avoid panels holding a
  // draft first — an empty input is a safe place to land even mid-stream, while
  // a draft would leave the user with two texts merged in one box.
  const emptyInput = ordered.find((panel) => !panel.hasContent);
  if (emptyInput) {
    return { slot: emptyInput.slot, delivery: 'prefill' };
  }

  return { slot: ordered[0]?.slot, delivery: 'prefill' };
}

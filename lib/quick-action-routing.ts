/**
 * Panel routing for quick actions.
 *
 * When a quick action arrives from the right-click menu we must pick which chat
 * panel handles it, and whether to send immediately or leave the prompt in the
 * input for the user to edit. The policy, in priority order:
 *
 * 1. Prefer a panel that is idle (not streaming) **and** has an empty input —
 *    that one can be sent without destroying anything. Rightmost first, since
 *    panel 0 is the primary panel the user's eye is on.
 * 2. Otherwise we must prefill. Prefer a panel with an empty input even if it is
 *    streaming: dropping the prompt into empty space costs the user nothing,
 *    whereas landing on a draft forces them to disentangle two texts.
 * 3. Otherwise every input holds a draft: fall back to the rightmost panel,
 *    i.e. panel 0. It always exists.
 *
 * "Rightmost first" means ascending panel id (see SplitView's id scheme: 0 is
 * rightmost). Only auto-sendable actions can reach outcome `send`; an action
 * with no prompt has nothing to send and is always a prefill.
 */

export interface PanelRoutingState {
  panelId: number;
  /** The panel is mid-stream and cannot accept a send. */
  isStreaming: boolean;
  /** The panel's input already holds text or attachments. */
  hasContent: boolean;
}

export type QuickActionDelivery = 'send' | 'prefill';

export interface QuickActionRoute {
  panelId: number;
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
  // Rightmost first: panel 0 is the primary panel, so ascending id is the
  // preference order in every tier below.
  const ordered = [...panels].sort((a, b) => a.panelId - b.panelId);

  if (canAutoSend) {
    const sendable = ordered.find((panel) => !panel.isStreaming && !panel.hasContent);
    if (sendable) {
      return { panelId: sendable.panelId, delivery: 'send' };
    }
  }

  // Nothing can be sent cleanly, so this is a prefill. Avoid panels holding a
  // draft first — an empty input is a safe place to land even mid-stream, while
  // a draft would leave the user with two texts merged in one box.
  const emptyInput = ordered.find((panel) => !panel.hasContent);
  if (emptyInput) {
    return { panelId: emptyInput.panelId, delivery: 'prefill' };
  }

  return { panelId: ordered[0]?.panelId ?? 0, delivery: 'prefill' };
}

/**
 * How the transcript scrolls while a reply streams.
 *
 * Two honest answers, and the difference is not cosmetic:
 *
 * - `'auto'` (default) — the historical behaviour: the list sticks to the
 *   bottom, so every new token is followed. Implemented by
 *   `use-stick-to-bottom`; see `components/chat/useChatScroll.ts`.
 * - `'anchor'` — the user's own message is pinned to the top of the viewport and
 *   the reply is rendered *below* it. Once the reply is taller than the screen,
 *   the view stays where it is: the overflow is only seen by scrolling.
 *
 * Free of i18next and browser APIs on purpose — `store/storage-schema.ts`
 * imports it, and that module is on the background worker's startup path.
 */

export type ChatScrollMode = 'auto' | 'anchor';

export const DEFAULT_CHAT_SCROLL_MODE: ChatScrollMode = 'auto';

/** Every valid value, in display order, shared by the options dropdown. */
export const CHAT_SCROLL_MODES: readonly ChatScrollMode[] = ['auto', 'anchor'];

/**
 * Coerces a stored or imported value into a mode.
 *
 * A config written before this setting existed, or a hand-edited export, must
 * land on `'auto'` — the behaviour every existing install already has.
 */
export function normalizeChatScrollMode(raw: unknown): ChatScrollMode {
  return CHAT_SCROLL_MODES.includes(raw as ChatScrollMode)
    ? (raw as ChatScrollMode)
    : DEFAULT_CHAT_SCROLL_MODE;
}

/** Geometry needed to place an anchored transcript. */
export interface AnchorLayoutMetrics {
  /** Visible height of the transcript element. */
  clientHeight: number;
  /**
   * Height the messages alone occupy — i.e. what the content element measures
   * *without* the bottom spacer the anchored mode reserves.
   */
  naturalHeight: number;
  /**
   * The anchor message's top edge, expressed in the transcript's *scroll*
   * coordinates (`scrollTop + rect distance from the content's top edge`).
   */
  anchorTop: number;
  /** Space kept above the viewport top edge, matching the list's own padding. */
  topPadding?: number;
}

export interface AnchorLayout {
  /** Room to reserve below the transcript so the anchor can reach the top. */
  spacerHeight: number;
  /** Offset that puts the anchor's top edge at the viewport top. */
  scrollTop: number;
}

/**
 * Where an anchored transcript should sit.
 *
 * A question cannot be scrolled to the top while there is nothing beneath it —
 * the browser clamps to `scrollHeight - clientHeight`, which is precisely why a
 * freshly sent message would otherwise stay glued to the bottom. So the mode
 * reserves exactly the missing room below the transcript (`spacerHeight`): once
 * it is applied, "the question's top at the viewport top" is reachable and the
 * message lands there immediately, before a single token has arrived.
 *
 * The spacer is deliberately derived from the *current* height, not fixed at
 * send time: as the reply grows, the reserved room shrinks by the same amount,
 * so the scroll offset never has to move. That is the freeze — no per-token
 * scrolling, no jitter, and no leftover blank space once the reply is taller
 * than the screen.
 */
export function computeAnchorLayout({
  clientHeight,
  naturalHeight,
  anchorTop,
  topPadding = 0,
}: AnchorLayoutMetrics): AnchorLayout {
  const spaceBelowAnchor = Math.max(0, naturalHeight - anchorTop);
  return {
    spacerHeight: Math.max(0, clientHeight - spaceBelowAnchor),
    scrollTop: Math.max(0, anchorTop - topPadding),
  };
}

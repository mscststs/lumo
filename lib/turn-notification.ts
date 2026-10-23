/**
 * When to show a desktop notification as an assistant turn settles.
 *
 * This module is deliberately free of i18next and any browser API beyond
 * `document.visibilityState`: `store/storage-schema.ts` imports it, and the
 * schema is on the background service worker's startup path. Pulling the app's
 * i18n bundle in would grow that worker for a value it never renders. The
 * actual notification lives in `lib/turn-notifier.ts`.
 */

/**
 * Completion-notification modes.
 *
 * - `'never'` — the default; notifications are opt-in.
 * - `'away'` — only while the side panel document is not visible, i.e. the
 *   browser window is unfocused, minimised, or the panel's tab is inactive.
 *   This is the useful case: the user cannot see the reply arrive.
 * - `'long'` — only for turns that took at least
 *   {@link LONG_TURN_NOTIFICATION_THRESHOLD_MS}, whatever the visibility. For a
 *   background research task this separates the reply worth walking back for
 *   from the quick answers that are not.
 * - `'always'` — also while the panel is on screen.
 */
export type TurnNotificationMode = 'never' | 'away' | 'long' | 'always';

/** Shipped default: off, so an upgrade never starts showing banners unasked. */
export const DEFAULT_TURN_NOTIFICATION: TurnNotificationMode = 'never';

/**
 * A turn at least this long earns a notification in `'long'` mode. Three
 * minutes is long enough to step away from, and short enough that an ordinary
 * single-round-trip reply never crosses it.
 */
export const LONG_TURN_NOTIFICATION_THRESHOLD_MS = 3 * 60 * 1000;

/** Every valid value, in display order, shared by the options dropdown. */
export const TURN_NOTIFICATION_MODES: readonly TurnNotificationMode[] = [
  'never',
  'away',
  'long',
  'always',
];

/**
 * Coerces a stored or imported value into a mode.
 *
 * A config written before this setting existed, or a hand-edited export, must
 * land on `'never'` rather than on an arbitrary mode — showing notifications a
 * user never opted into is the one outcome worth being conservative about.
 */
export function normalizeTurnNotification(raw: unknown): TurnNotificationMode {
  return TURN_NOTIFICATION_MODES.includes(raw as TurnNotificationMode)
    ? (raw as TurnNotificationMode)
    : DEFAULT_TURN_NOTIFICATION;
}

/**
 * Whether a notification should be shown right now, given the configured mode.
 *
 * `elapsedMs` is the turn's total wall-clock duration, used only by `'long'`.
 * Callers that cannot measure it (or the default of `0`) make `'long'` a no-op
 * rather than an accidental notification.
 *
 * `'away'` reads the panel document's visibility rather than `document.hasFocus`
 * on purpose: a panel that is on screen but whose focus sits in the page is
 * still something the user can watch, and notifying there would defeat the
 * `'always'` / `'away'` distinction. `visibilityState` is the browser's own
 * answer to "is this document in front of the user". `'long'` ignores visibility
 * by design — it exists to catch the tasks that ran too long to sit through.
 *
 * Non-document contexts (tests, the background) cannot observe visibility, so
 * `'away'` is a no-op there rather than an accidental notification.
 */
export function shouldNotifyTurnComplete(
  mode: TurnNotificationMode,
  elapsedMs = 0,
): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  if (mode === 'long') return elapsedMs >= LONG_TURN_NOTIFICATION_THRESHOLD_MS;
  if (typeof document === 'undefined') return false;
  return document.visibilityState !== 'visible';
}

/**
 * Desktop notification when an assistant turn settles.
 *
 * A reply can take minutes — a browsing task chains dozens of tool calls — so
 * the side panel is not where the user stays while it runs. The decision of
 * *whether* to notify is pure policy and lives in
 * `lib/turn-notification.ts`; this module is only the side effect.
 *
 * The notification is created by the side panel document, which owns the
 * stream — a turn only ever completes while that document is alive. The
 * background does not show it; it only handles the click, because
 * `chrome.notifications.onClicked` is registered once there rather than once per
 * panel. See `entrypoints/background.ts`.
 *
 * `chrome.notifications.create` can reject (the user disabled notifications for
 * the browser, no icon, an unavailable API), and none of that is the user's
 * chat. Every path here swallows its error into a log; the turn has already
 * finished and its reply is on screen.
 */

import i18n from '@/i18n';
import { TURN_NOTIFICATION_ID } from '@/lib/constants';
import {
  shouldNotifyTurnComplete,
  type TurnNotificationMode,
} from '@/lib/turn-notification';

/** Absolute URL of the notification icon, or `undefined` when unavailable. */
function resolveIconUrl(): string | undefined {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime?.getURL) return undefined;
  try {
    return runtime.getURL('icon/128.png');
  } catch {
    return undefined;
  }
}

function bodyKey(failed: boolean, hasTitle: boolean): string {
  if (failed) {
    return hasTitle
      ? 'notification.turnComplete.failedMessageWithTitle'
      : 'notification.turnComplete.failedMessage';
  }
  return hasTitle
    ? 'notification.turnComplete.messageWithTitle'
    : 'notification.turnComplete.message';
}

export interface TurnNotificationOptions {
  /** Conversation title, used to tell one finished reply from another. */
  title?: string;
  /** The turn ended in a failure rather than a reply. */
  failed?: boolean;
  /** Total wall-clock duration of the turn, for the `'long'` mode. */
  elapsedMs?: number;
}

/**
 * Shows the completion notification, if the mode and the current visibility
 * allow it. Fire-and-forget from the caller's perspective.
 */
export async function notifyTurnComplete(
  mode: TurnNotificationMode,
  options: TurnNotificationOptions = {},
): Promise<void> {
  if (!shouldNotifyTurnComplete(mode, options.elapsedMs ?? 0)) return;

  const notifications =
    typeof chrome !== 'undefined' ? chrome.notifications : undefined;
  if (!notifications?.create) return;

  const title = options.title?.trim();
  const iconUrl = resolveIconUrl();
  // `iconUrl` is required by `chrome.notifications.create`; without it there is
  // nothing to draw and the call would reject anyway.
  if (!iconUrl) return;

  try {
    await notifications.create(TURN_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl,
      title: i18n.t('notification.turnComplete.title'),
      message: i18n.t(bodyKey(options.failed === true, !!title), { title }),
      priority: 1,
    });
  } catch (error) {
    // A refused notification (permission, platform) must never surface as a
    // chat failure — the reply is already on screen.
    console.error('[Lumo] Failed to show the completion notification:', error);
  }
}

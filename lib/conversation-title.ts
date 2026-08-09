/**
 * Conversation titles: how one is derived when a chat starts, and what to show
 * when there was nothing to derive it from.
 *
 * The placeholder is deliberately **not** persisted. It used to be written into
 * the record as the literal string `'New Chat'`, which was wrong twice over: it
 * bypassed i18n outright, so a 中文 user's history filled up with English
 * titles; and even localised at write time it would be a UI string frozen into
 * the database at whatever language happened to be active, still reading English
 * after a switch. An untitled conversation stores `''` instead and every render
 * site resolves it through `conversationTitle`.
 */

/** Minimal shape of the i18next `t` function this module needs. */
type Translate = (key: string) => string;

/**
 * How much of the opening message becomes the title.
 *
 * Titles are single-line and truncated wherever they appear, so this only has to
 * be short enough to stay cheap to store in every conversation summary.
 */
export const TITLE_MAX_CHARS = 50;

/**
 * Title for a conversation being created from its opening message.
 *
 * Empty when that turn carries no text — an image-only or attachment-only ask —
 * which is precisely the case the placeholder exists for.
 */
export function deriveConversationTitle(text: string): string {
  return text.trim().slice(0, TITLE_MAX_CHARS);
}

/**
 * The title to display, falling back to the localised placeholder.
 *
 * Also covers records written before titles could be empty, whose stored title
 * is the old hardcoded `'New Chat'` — those keep rendering verbatim rather than
 * being rewritten, since a migration would touch every conversation to fix a
 * label the user is about to overwrite by renaming anyway.
 */
export function conversationTitle(title: string, t: Translate): string {
  return title.trim() || t('sidebar.history.untitled');
}

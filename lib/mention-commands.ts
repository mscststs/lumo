/**
 * Mention commands — the `@` vocabulary of the chat composer.
 *
 * A mention is a *reference trigger*: typing `@` anywhere a word can start opens
 * a picker of attachable resources (browser tabs, stored files). Selecting one
 * adds a `TextAttachment` chip to the input — page-context for tabs, file-ref
 * for files — exactly the same payloads that dragging a tab or a file produces.
 *
 * Unlike slash commands (`/`), mentions:
 * - Use `word-start` placement so they can fire at any point in the draft.
 * - Always apply on selection — there is no "send-time" mode.
 * - Never leave text in the input; the trigger token is consumed and replaced
 *   by nothing (the attachment lives in the chip strip, not inline).
 *
 * This module is data-only — no React, no `chrome.*` — so the options page
 * and the composer share one set of types and defaults.
 */

/** The character that opens a mention in the composer. */
export const MENTION_PREFIX = '@';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface MentionSettings {
  /** Master switch. When off, `@` is just a character. */
  enabled: boolean;
  /** Whether browser tabs appear in the picker. */
  tabsEnabled: boolean;
  /** Whether stored files appear in the picker. */
  filesEnabled: boolean;
}

export const DEFAULT_MENTION_SETTINGS: MentionSettings = {
  enabled: true,
  tabsEnabled: true,
  filesEnabled: true,
};

// ---------------------------------------------------------------------------
// Normalisation (storage + import)
// ---------------------------------------------------------------------------

/**
 * Coerces a stored or imported record into usable settings.
 */
export function normalizeMentionSettings(raw: unknown): MentionSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_MENTION_SETTINGS;
  const source = raw as Partial<MentionSettings>;
  return {
    enabled: source.enabled !== false,
    tabsEnabled: source.tabsEnabled !== false,
    filesEnabled: source.filesEnabled !== false,
  };
}

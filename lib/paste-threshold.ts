/**
 * When a paste into the chat composer becomes an attachment instead of inline text.
 *
 * Pasting a long block is how users hand the model a document, and inline text
 * buries the rest of the draft under thousands of characters. Past a threshold
 * the paste is turned into a text attachment chip instead, so the input stays
 * free for the actual question while the content still reaches the model.
 *
 * The threshold is a plain character count, which lets a user-chosen value be
 * stored in the same field as the presets. `0` is reserved for "never" — the one
 * value that cannot mean a length, since no paste is shorter than nothing — and
 * `1` therefore reads as "always": every non-empty paste attaches.
 */

/** Pastes always land inline, whatever their length. */
export const PASTE_NEVER = 0;

/** Every non-empty paste becomes an attachment. */
export const PASTE_ALWAYS = 1;

export const DEFAULT_PASTE_THRESHOLD = 500;

/**
 * Upper bound on a custom value. Not a technical limit — it keeps a stray digit
 * from producing a threshold no paste can ever reach, which would look
 * indistinguishable from "never" while the dropdown claimed otherwise.
 */
export const MAX_PASTE_THRESHOLD = 1_000_000;

/** Presets offered by the options page, in display order. */
export const PASTE_THRESHOLD_PRESETS = [PASTE_NEVER, 500, 2500, PASTE_ALWAYS] as const;

/** Whether `value` is one of the dropdown presets rather than a custom count. */
export function isPasteThresholdPreset(value: number): boolean {
  return (PASTE_THRESHOLD_PRESETS as readonly number[]).includes(value);
}

/**
 * Coerces a stored or user-typed threshold into a usable character count.
 *
 * Anything non-numeric falls back to the default rather than to `0`: a config
 * written before this setting existed must not silently read as "never".
 */
export function normalizePasteThreshold(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_PASTE_THRESHOLD;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PASTE_THRESHOLD;
  return Math.min(Math.max(Math.trunc(n), PASTE_NEVER), MAX_PASTE_THRESHOLD);
}

/** Whether a pasted string is long enough to be attached rather than inlined. */
export function shouldAttachPaste(text: string, threshold: number): boolean {
  if (threshold <= PASTE_NEVER) return false;
  return text.length >= threshold;
}

/**
 * Trigger-token detection for the chat composer.
 *
 * A trigger is a single character (`/`, `@`, …) that opens a suggestion menu
 * over the word the caret is currently inside. This module is pure and
 * trigger-agnostic: it never knows about slash commands or file mentions, only
 * about "character X at position Y, with these placement rules". That is what
 * makes a second trigger free to add later — register another character, keep
 * the same caret logic.
 *
 * ## Placement
 *
 * - `input-start`: the trigger must be the first character of the whole value.
 *   Slash commands use this so a `/` mid-sentence stays a slash.
 * - `word-start`: the trigger must open a word — either at the start of the
 *   value or immediately after whitespace. Mentions use this so `@file` can
 *   appear anywhere a word can.
 *
 * ## Caret inside the token
 *
 * The active range extends to the nearest whitespace on either side of the
 * caret, not only to the caret itself. Typing `/ne|w` still matches `/new`, and
 * selecting it replaces the whole token rather than leaving a trailing `w`.
 */

export type TriggerPlacement = 'input-start' | 'word-start';

export interface TriggerSpec {
  /** The character that opens the menu (`/`, `@`, …). */
  char: string;
  placement: TriggerPlacement;
}

export interface ActiveTrigger {
  /** The character that matched. */
  char: string;
  /** Text after the trigger, up to the caret's word boundary. */
  query: string;
  /** Inclusive start of the whole token (the trigger itself). */
  start: number;
  /** Exclusive end of the whole token. */
  end: number;
}

/** Whether `char` is whitespace in the sense the composer uses for word edges. */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * Finds the trigger-token the caret is currently inside, if any.
 *
 * Walks left from the caret to the previous word edge, checks that the first
 * character there is a registered trigger in a legal placement, then walks right
 * to the next word edge so the whole token is claimed for replacement.
 */
export function findActiveTrigger(
  value: string,
  caret: number,
  triggers: readonly TriggerSpec[],
): ActiveTrigger | null {
  if (triggers.length === 0) return null;

  const clamped = Math.max(0, Math.min(caret, value.length));

  // Walk left to the start of the current word.
  let start = clamped;
  while (start > 0 && !isBoundary(value[start - 1])) start -= 1;

  const triggerChar = value[start];
  if (triggerChar === undefined) return null;

  const spec = triggers.find((candidate) => candidate.char === triggerChar);
  if (!spec) return null;

  if (spec.placement === 'input-start') {
    if (start !== 0) return null;
  } else if (!isBoundary(value[start - 1])) {
    // `word-start` with a non-boundary behind the trigger is unreachable via the
    // left-walk above, but the check documents the rule and guards against a
    // future rewrite that starts the search differently.
    return null;
  }

  // Walk right to the end of the word so a mid-token caret still claims it.
  let end = clamped;
  while (end < value.length && !isBoundary(value[end])) end += 1;

  // The token must still be "open": a space after the trigger means the user has
  // already finished typing it, so the menu has nothing left to complete.
  // (A bare trigger with the caret right after it — `/|` — is open and empty.)
  if (end === start) return null;

  return {
    char: triggerChar,
    query: value.slice(start + 1, end),
    start,
    end,
  };
}

/**
 * Replaces the active token with `insertion` and returns the new value plus
 * where the caret should land (immediately after the insertion).
 *
 * The caller owns the trailing space: slash-command completion wants one so the
 * user can keep typing the rest of the message; a bare mention may not.
 */
export function replaceTriggerToken(
  value: string,
  token: Pick<ActiveTrigger, 'start' | 'end'>,
  insertion: string,
): { value: string; caret: number } {
  const next = value.slice(0, token.start) + insertion + value.slice(token.end);
  return { value: next, caret: token.start + insertion.length };
}

/**
 * How many tool-loop steps a single assistant turn may run before it stops.
 *
 * One step is one model round-trip: the model either answers — which ends the
 * turn — or calls tools, whose results feed the next step. A browsing task
 * routinely needs dozens of them (open a page, read it, follow a link, read
 * again), so a low cap surfaces as a reply that halts mid-task right after a
 * tool result, leaving the user to type "continue" to get the rest.
 *
 * The cap is a plain step count, which lets a user-chosen value be stored in the
 * same field as the presets. `0` is reserved for "never pause" — the one value
 * that cannot mean a real count, since a turn allowed zero steps could never
 * answer at all — and it sits below `MIN_MAX_STEPS`, so it can never be confused
 * with a custom cap.
 */

/** No cap: the loop runs until the model stops calling tools. */
export const STEPS_NEVER = 0;

/**
 * Lower bound on a custom cap. Not a technical limit — below roughly this many
 * steps an ordinary multi-step task cannot finish, so *every* such turn would
 * stop short and the setting would read as broken rather than as strict.
 */
export const MIN_MAX_STEPS = 10;

/**
 * Unbounded by default. A cap only ever stops a turn the model was not done
 * with, and there is no step count that is right for every task, so the
 * out-of-the-box behaviour is to let the model decide when it is finished.
 */
export const DEFAULT_MAX_STEPS = STEPS_NEVER;

/** Presets offered by the options page, in display order. */
export const MAX_STEPS_PRESETS = [STEPS_NEVER, 20, 60] as const;

/** Whether `value` is one of the dropdown presets rather than a custom count. */
export function isMaxStepsPreset(value: number): boolean {
  return (MAX_STEPS_PRESETS as readonly number[]).includes(value);
}

/**
 * Coerces a stored or user-typed cap into a usable step count.
 *
 * Anything that is not a positive count reads as "never", so a config written
 * before this setting existed does not acquire a cap it never asked for.
 * `Infinity` lands there too: it is what a hand-edited export might carry, and
 * `JSON.stringify` turns it into `null` on the way back out, which is exactly
 * why it is not used as the "no cap" representation in the first place.
 *
 * A positive value below `MIN_MAX_STEPS` is raised to it rather than rejected —
 * the options page clamps as you type, so a smaller number here came from an
 * imported or hand-edited config, where honouring it literally would truncate
 * every single turn.
 */
export function normalizeMaxSteps(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_MAX_STEPS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  const steps = Math.trunc(n);
  if (steps <= STEPS_NEVER) return STEPS_NEVER;
  return Math.max(steps, MIN_MAX_STEPS);
}

/**
 * Whether the tool loop is allowed to run the (0-based) step `step`.
 *
 * The uncapped case is checked first so `STEPS_NEVER` never reads as "zero steps
 * allowed", which would make the turn produce nothing at all.
 */
export function stepAllowed(step: number, maxSteps: number): boolean {
  return maxSteps === STEPS_NEVER || step < maxSteps;
}

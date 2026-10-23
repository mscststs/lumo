/**
 * Declared context window for a model, in tokens.
 *
 * Kept as a plain optional number shared by the model form's presets and its
 * free-form entry, the same way `max-steps.ts` shares a step count. The window
 * is *configuration*, not a measurement: providers do not report it, so the
 * user declares it and the composer's context ring divides by it.
 *
 * `undefined` means "not declared", which is deliberately distinct from `0`:
 * the ring is hidden rather than drawn against an invented window.
 */

/**
 * Presets offered by the model form, largest first.
 *
 * Decimal thousands (not 1024) because that is how model cards state windows —
 * "128K" reads as 128000, not 131072 — and because a round number is easier to
 * compare against the provider's documentation than a binary one.
 */
export const CONTEXT_WINDOW_PRESETS = [1_000_000, 256_000, 128_000, 64_000, 32_000] as const;

/**
 * Lower bound on a custom window. A value below this cannot be a real context
 * window, so a smaller one is far more likely to be a typo — or a "max output"
 * count entered in the wrong box — than an intentional setting.
 */
export const MIN_CONTEXT_WINDOW = 1_000;

/**
 * Upper bound. Guards the percentage against a typed or imported number so
 * large that every real prompt would read as 0%.
 */
export const MAX_CONTEXT_WINDOW = 10_000_000;

/** Whether `value` is one of the dropdown presets rather than a custom window. */
export function isContextWindowPreset(value: number): boolean {
  return (CONTEXT_WINDOW_PRESETS as readonly number[]).includes(value);
}

/**
 * Coerces a stored or user-typed window into a usable token count.
 *
 * Anything that is not a positive count at or above `MIN_CONTEXT_WINDOW` reads
 * as "not declared", so a config written before this field existed does not
 * acquire a window it never asked for.
 */
export function normalizeContextWindow(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const tokens = Math.trunc(n);
  if (tokens < MIN_CONTEXT_WINDOW) return undefined;
  return Math.min(tokens, MAX_CONTEXT_WINDOW);
}

/**
 * Compact token count for labels and tooltips, matching the convention model
 * cards use: `32K`, `128K`, `1M`.
 *
 * Kept local rather than reused from the debug view so the two can diverge: the
 * debug view prints exact counts for auditing, whereas a ring label is a glance
 * and rounding to one decimal is all the precision that reads.
 */
export function formatContextTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) {
    const k = count / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  const m = count / 1_000_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/**
 * Message timestamps: a coarse relative label for the toolbar, and the full
 * localised date/time for its hover tooltip.
 *
 * Deliberately built on `Intl.RelativeTimeFormat` / `Intl.DateTimeFormat` rather
 * than on i18next keys: "3 minutes ago", "3分钟前", "vor 3 Minuten" and the
 * absolute fallback ("Mar 5, 2:32 PM" vs "3月5日 14:32") are CLDR data, not
 * copy. Hardcoding them as translations would need one key per unit per locale
 * (plus plural categories), and would still get the date ordering, the
 * 12/24-hour convention and the digit shaping wrong for half of the bundles.
 * The trade-off is that nothing here needs translating, which is also why
 * `scripts/i18n/check.mjs` has nothing to check for it.
 *
 * Formatting follows the convention the big chat products settled on:
 *
 * - under a minute: "now" (`numeric: 'auto'` renders 0 as the local word),
 * - under an hour: minutes,
 * - under a day: hours,
 * - a day or more: an absolute date and time, with the year only when it is
 *   not the current one. Past a day "27 hours ago" is harder to place than
 *   "Mar 5, 2:32 PM", and a year on every message from this week is noise.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * `Intl` formatters are expensive to construct and every visible message
 * formats on every minute tick, so they are cached per locale (and per shape).
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const absoluteFormatters = new Map<string, Intl.DateTimeFormat>();
const fullFormatters = new Map<string, Intl.DateTimeFormat>();

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = relativeFormatters.get(locale);
  if (!formatter) {
    // `numeric: 'auto'` is what produces "yesterday"/"昨天" instead of
    // "1 day ago", and "now" instead of "in 0 seconds".
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormatters.set(locale, formatter);
  }
  return formatter;
}

function absoluteFormatter(locale: string, withYear: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${withYear ? 'year' : 'no-year'}`;
  let formatter = absoluteFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      ...(withYear ? { year: 'numeric' as const } : {}),
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    absoluteFormatters.set(key, formatter);
  }
  return formatter;
}

function fullFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = fullFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'short',
    });
    fullFormatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * The short label shown in the message toolbar.
 *
 * `now` is passed in rather than read here so the shared ticker
 * (`lib/use-now.ts`) drives every timestamp from one clock, and so this stays a
 * pure function the tests can pin.
 */
export function formatMessageTime(timestamp: number, now: number, locale: string): string {
  const formatter = relativeFormatter(locale);
  const delta = timestamp - now; // negative for the past
  const magnitude = Math.abs(delta);

  if (magnitude < MINUTE_MS) return formatter.format(0, 'second');
  if (magnitude < HOUR_MS) return formatter.format(Math.round(delta / MINUTE_MS), 'minute');
  if (magnitude < DAY_MS) return formatter.format(Math.round(delta / HOUR_MS), 'hour');

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return absoluteFormatter(locale, !sameYear).format(date);
}

/**
 * The exact date and time behind the relative label, shown in the message
 * toolbar's hover tooltip and mirrored into `aria-label`. Unabbreviated on
 * purpose: this is what the user reaches for when the relative label is not
 * precise enough.
 */
export function formatMessageTimeTitle(timestamp: number, locale: string): string {
  return fullFormatter(locale).format(new Date(timestamp));
}

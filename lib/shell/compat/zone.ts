/**
 * Wall-clock arithmetic in a named time zone.
 *
 * Two shims need it: `date` (relative expressions are applied to the local
 * calendar, not to a millisecond count) and `touch -t` (a timestamp without an
 * offset is local time). Doing either in epoch milliseconds is wrong by an hour
 * twice a year and by the whole offset everywhere outside UTC.
 *
 * `Intl` is the only zone database available in the extension, so the offset is
 * sampled at the instant in question and the conversion is iterated until it
 * settles — the same approach just-bash's own `date` uses for bare ISO input.
 */

interface WallClock {
  year: number;
  /** 0-based, like `Date.getUTCMonth`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(zone, formatter);
  return formatter;
}

function isValidZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The zone a command computes in: a valid `$TZ`, otherwise UTC. */
export function zoneFrom(tz: string | undefined, utc = false): string {
  if (utc) return 'UTC';
  return tz !== undefined && isValidZone(tz) ? tz : 'UTC';
}

/** Break an instant down into the wall clock a person in `zone` would read. */
export function wallClock(ms: number, zone: string): WallClock {
  if (zone === 'UTC') {
    const date = new Date(ms);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      weekday: date.getUTCDay(),
    };
  }
  const values = new Map<string, number>();
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values.set(part.type, Number(part.value));
  }
  const year = values.get('year') ?? 1970;
  const month = (values.get('month') ?? 1) - 1;
  const day = values.get('day') ?? 1;
  return {
    year,
    month,
    day,
    hour: values.get('hour') ?? 0,
    minute: values.get('minute') ?? 0,
    second: values.get('second') ?? 0,
    weekday: new Date(Date.UTC(year, month, day)).getUTCDay(),
  };
}

/** How far `zone` is ahead of UTC at `ms`, in milliseconds. */
function zoneOffset(ms: number, zone: string): number {
  const clock = wallClock(ms, zone);
  return Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute, clock.second) - ms;
}

type Clock = Omit<WallClock, 'weekday'>;

/** The instant at which `zone` shows the given wall clock. */
export function zoneInstant(clock: Clock, zone: string): number {
  const naive = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute, clock.second);
  if (zone === 'UTC') return naive;
  // Two refinement passes settle the offset either side of a DST boundary.
  let candidate = naive - zoneOffset(naive, zone);
  for (let pass = 0; pass < 2; pass += 1) {
    const corrected = naive - zoneOffset(candidate, zone);
    if (corrected === candidate) break;
    candidate = corrected;
  }
  return candidate;
}

/** Add signed calendar fields to the wall clock, normalising like `mktime`. */
export function addToWallClock(
  ms: number,
  delta: { months?: number; days?: number; seconds?: number },
  zone: string,
): number {
  const clock = wallClock(ms, zone);
  const normalized = new Date(
    Date.UTC(
      clock.year,
      clock.month + (delta.months ?? 0),
      clock.day + (delta.days ?? 0),
      clock.hour,
      clock.minute,
      clock.second + (delta.seconds ?? 0),
    ),
  );
  return zoneInstant(
    {
      year: normalized.getUTCFullYear(),
      month: normalized.getUTCMonth(),
      day: normalized.getUTCDate(),
      hour: normalized.getUTCHours(),
      minute: normalized.getUTCMinutes(),
      second: normalized.getUTCSeconds(),
    },
    zone,
  );
}

export function startOfDay(ms: number, zone: string): number {
  const clock = wallClock(ms, zone);
  return zoneInstant({ ...clock, hour: 0, minute: 0, second: 0 }, zone);
}

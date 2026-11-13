/**
 * `date` — add `-r` and GNU's relative `-d` expressions.
 *
 * just-bash's `date` understands `now`, `today`, `yesterday`, `tomorrow`,
 * `@epoch` and ISO timestamps, and formats with a complete `strftime`. What it
 * lacks is the two forms scripts reach for most: read a file's mtime, and do
 * arithmetic in words (`+1 day`, `2 hours ago`, `next monday`).
 *
 * Both are argument-level features, so they are rewritten here into the one form
 * the original already supports (`-d @<epoch>`) and the original does the
 * formatting, timezone handling and error messages. Anything this parser does
 * not understand is forwarded untouched, so `date` keeps its existing behaviour
 * for every case it already handled.
 *
 * The arithmetic mirrors GNU, which applies relative items to the *wall clock*
 * and lets `mktime` normalise: `+1 day` across a DST boundary keeps the local
 * time of day, `2026-01-31 +1 month` lands on 2026-03-03, and `next monday`
 * zeroes the time of day. Doing the same in epoch milliseconds would be wrong by
 * an hour twice a year, so every step converts through `zone.ts`.
 */

import { defineCommand, type ExecResult } from 'just-bash/browser';
import { addToWallClock, startOfDay, wallClock, zoneFrom, zoneInstant } from './zone';

/** Units GNU adds to the wall clock, in the order `date --help` lists them. */
const UNIT_MONTHS: Record<string, number | undefined> = {
  month: 1,
  months: 1,
  year: 12,
  years: 12,
};

/** Calendar units, in days. */
const UNIT_DAYS: Record<string, number> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  fortnight: 14,
  fortnights: 14,
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseAmount(token: string): number | undefined {
  if (!/^[+-]?\d+$/.test(token)) return undefined;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : undefined;
}

function weekdayIndex(token: string): number | undefined {
  const lower = token.toLowerCase();
  if (lower.length < 3) return undefined;
  const index = WEEKDAYS.findIndex((day) => day.startsWith(lower));
  return index === -1 ? undefined : index;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** A trailing time of day in the space-separated form: `2026-11-13 09:30`. */
const CLOCK_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function parseBareDate(token: string, zone: string): number | undefined {
  const match = ISO_DATE.exec(token);
  if (!match) return undefined;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const clock = {
    year: Number(year),
    month: Number(month) - 1,
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  const instant = zoneInstant(clock, zone);
  // Reject rollovers (2026-02-30) instead of silently landing in March.
  const shown = wallClock(instant, zone);
  if (shown.month !== clock.month || shown.day !== clock.day) return undefined;
  return instant;
}

/** `next monday` / `last friday` / `this sunday`: whole days, time zeroed. */
function applyWeekday(ms: number, mode: string, target: number, zone: string): number {
  const current = wallClock(ms, zone).weekday;
  let days: number;
  if (mode === 'next') days = (target - current + 7) % 7 || 7;
  else if (mode === 'last') days = -((current - target + 7) % 7 || 7);
  else days = (target - current + 7) % 7;
  return startOfDay(addToWallClock(ms, { days }, zone), zone);
}

/** One `N unit` / `N unit ago` item, or `undefined` when it is not one. */
function applyItem(
  ms: number,
  tokens: string[],
  at: number,
  zone: string,
): { ms: number; next: number } | undefined {
  const amount = parseAmount(tokens[at]!);
  if (amount === undefined) return undefined;
  const unit = tokens[at + 1]?.toLowerCase();
  if (unit === undefined) return undefined;

  const ago = tokens[at + 2]?.toLowerCase() === 'ago';
  const step = ago ? -amount : amount;
  const next = at + (ago ? 3 : 2);

  const months = UNIT_MONTHS[unit];
  if (months !== undefined) return { ms: addToWallClock(ms, { months: step * months }, zone), next };

  const days = UNIT_DAYS[unit] ?? 0;
  if (days !== 0) return { ms: addToWallClock(ms, { days: step * days }, zone), next };

  const seconds = unitSeconds(unit);
  if (seconds === undefined) return undefined;
  return { ms: addToWallClock(ms, { seconds: step * seconds }, zone), next };
}

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  seconds: 1,
  sec: 1,
  secs: 1,
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
  hour: 3600,
  hours: 3600,
  hr: 3600,
  hrs: 3600,
};

function unitSeconds(unit: string): number | undefined {
  return UNIT_SECONDS[unit];
}

/** Apply a `HH:MM[:SS]` token to the day already chosen. */
function setTimeOfDay(ms: number, token: string, zone: string): number | undefined {
  const clock = CLOCK_TIME.exec(token);
  if (!clock) return undefined;
  const day = wallClock(ms, zone);
  return zoneInstant(
    { ...day, hour: Number(clock[1]), minute: Number(clock[2]), second: Number(clock[3] ?? 0) },
    zone,
  );
}

interface Base {
  ms: number;
  /** Index of the first modifier. */
  at: number;
}

/**
 * The instant the modifiers apply to, and where they start.
 *
 * `'keyword'` means the whole input is one token, which the original command
 * handles better (`now`, `today`, ISO, `@epoch`).
 */
function resolveBase(tokens: string[], zone: string, nowMs: number): Base | 'keyword' | null {
  if (tokens.length === 1) return 'keyword';
  const bare = parseBareDate(tokens[0]!, zone);
  if (bare === undefined) return { ms: nowMs, at: 0 };
  // `2026-03-08 12:00 +1 day`: the date and the clock are separate tokens.
  const withClock = setTimeOfDay(bare, tokens[1]!, zone);
  return withClock === undefined ? { ms: bare, at: 1 } : { ms: withClock, at: 2 };
}

const SINGLE_DAY: Record<string, number> = { yesterday: -1, tomorrow: 1 };

/**
 * Parse the relative forms GNU accepts, as epoch seconds.
 *
 * Returns `null` for anything outside this subset; the caller then delegates to
 * the original command. A bare timestamp with no relative item is also `null`:
 * the original parses it in `$TZ` correctly, and re-deriving it here would only
 * duplicate that.
 */
function parseRelativeDate(input: string, zone: string, nowMs = Date.now()): number | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const base = resolveBase(tokens, zone, nowMs);
  if (base === null) return null;
  if (base === 'keyword') {
    const days = SINGLE_DAY[tokens[0]!.toLowerCase()];
    return days === undefined ? null : Math.floor(addToWallClock(nowMs, { days }, zone) / 1000);
  }

  let ms = base.ms;
  let at = base.at;

  while (at < tokens.length) {
    const token = tokens[at]!.toLowerCase();
    if (token === 'next' || token === 'last' || token === 'this') {
      const target = tokens[at + 1] === undefined ? undefined : weekdayIndex(tokens[at + 1]!);
      if (target === undefined) return null;
      ms = applyWeekday(ms, token, target, zone);
      at += 2;
      continue;
    }
    const clock = setTimeOfDay(ms, tokens[at]!, zone);
    if (clock !== undefined) {
      ms = clock;
      at += 1;
      continue;
    }
    const item = applyItem(ms, tokens, at, zone);
    if (!item) return null;
    ms = item.ms;
    at = item.next;
  }

  return Math.floor(ms / 1000);
}

interface Parsed {
  /** Rebuilt argument list, or `null` when nothing had to change. */
  args: string[] | null;
  error?: ExecResult;
}

/** Locate the two options this shim rewrites. */
function scan(args: string[]): {
  reference?: string;
  dateValue?: string;
  missingReference: boolean;
} {
  let reference: string | undefined;
  let dateValue: string | undefined;
  let missingReference = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (arg === '-r' || arg === '--reference') {
      reference = args[i + 1];
      if (reference === undefined) missingReference = true;
      else i += 1;
      continue;
    }
    if (arg.startsWith('--reference=')) {
      reference = arg.slice('--reference='.length);
      continue;
    }
    if (arg === '-d' || arg === '--date') {
      dateValue = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--date=')) dateValue = arg.slice('--date='.length);
  }

  return { ...(reference !== undefined ? { reference } : {}), ...(dateValue !== undefined ? { dateValue } : {}), missingReference };
}

/** Rewrite `-r` and relative `-d` into `-d @<epoch>`. */
async function rewrite(
  args: string[],
  zone: string,
  resolve: (file: string) => Promise<number | undefined>,
): Promise<Parsed> {
  const found = scan(args);
  if (found.missingReference) {
    return {
      args: null,
      error: { stdout: '', stderr: "date: option requires an argument -- 'r'\n", exitCode: 1 },
    };
  }

  let epoch: number | undefined;
  let changed = false;

  if (found.reference !== undefined) {
    const mtime = await resolve(found.reference);
    if (mtime === undefined) {
      return {
        args: null,
        error: {
          stdout: '',
          stderr: `date: ${found.reference}: No such file or directory\n`,
          exitCode: 1,
        },
      };
    }
    epoch = Math.floor(mtime / 1000);
    changed = true;
  }

  if (found.dateValue !== undefined && !found.dateValue.startsWith('@')) {
    const relative = parseRelativeDate(found.dateValue, zone);
    if (relative !== null) {
      epoch = relative;
      changed = true;
    }
  }

  if (!changed) return { args: null };
  return { args: rebuild(args, epoch) };
}

/** Drop `-r`/`--reference` (and its value): the epoch replaces it. */
function stripReference(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') {
      out.push(...args.slice(i));
      break;
    }
    if (arg === '-r' || arg === '--reference') {
      i += 1;
      continue;
    }
    if (!arg.startsWith('--reference=')) out.push(arg);
  }
  return out;
}

/** Substitute the resolved instant for a `-d` value, or report that none was written. */
function replaceDate(args: string[], epoch: number | undefined): { args: string[]; written: boolean } {
  if (epoch === undefined) return { args, written: false };
  const out: string[] = [];
  let written = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') {
      out.push(...args.slice(i));
      break;
    }
    if (arg === '-d' || arg === '--date') {
      out.push('-d', `@${epoch}`);
      written = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--date=')) {
      out.push(`--date=@${epoch}`);
      written = true;
      continue;
    }
    out.push(arg);
  }

  return { args: out, written };
}

/** Rebuild the argument list with the resolved timestamp in place of the source. */
function rebuild(args: string[], epoch: number | undefined): string[] {
  const replaced = replaceDate(stripReference(args), epoch);
  if (epoch === undefined || replaced.written) return replaced.args;
  return [...replaced.args, '-d', `@${epoch}`];
}

export function createDateCommand() {
  return defineCommand('date', async (args, ctx) => {
    const original = ctx.origCommand;
    if (!original) return { stdout: '', stderr: 'date: command is not available\n', exitCode: 127 };

    // `-u` fixes the calendar `date` computes in, exactly as GNU does.
    const utc = args.some((arg) => arg === '--utc' || (/^-[^-]/.test(arg) && arg.includes('u')));
    const zone = zoneFrom(ctx.env.get('TZ'), utc);
    const resolved = await rewrite(args, zone, async (file) => {
      try {
        return (await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, file))).mtime.getTime();
      } catch {
        return undefined;
      }
    });

    if (resolved.error) return resolved.error;
    return original(resolved.args ?? args);
  });
}

/**
 * `touch` — apply `-t` and `-r`.
 *
 * just-bash's `touch` accepts both flags and then throws them away (the source
 * says "silently ignore … for now"), so `touch -t 202001010000 file` exits 0
 * and leaves the mtime untouched. Scripts that build a reference timestamp with
 * `touch -t` then feed it to `find -newer` silently compare against "now".
 *
 * `ctx.fs.utimes` is part of the filesystem interface and the extension VFS
 * implements it, so the fix is local: compute the instant and set it. `-d` and
 * the flag-less "touch to now" path stay with the original command, which
 * already handles them. `-a`/`-m` select which timestamp to move in a real
 * filesystem; this one records a single mtime, so both move it together.
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';
import { wallClock, zoneFrom, zoneInstant } from './zone';

/**
 * GNU `touch -t [[CC]YY]MMDDhhmm[.ss]`.
 *
 * The stamp carries no offset, so it is local time in `$TZ` — the same rule GNU
 * applies. Parsed at UTC the result would be off by the whole zone offset.
 */
function parseTouchStamp(value: string, zone: string): Date | null {
  const match = /^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/.exec(value);
  if (!match) return null;

  const digits = match[1]!;
  const seconds = match[2] === undefined ? 0 : Number(match[2]);
  const year = yearFrom(digits, zone);
  const rest = digits.length === 12 ? digits.slice(4) : digits.length === 10 ? digits.slice(2) : digits;

  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || seconds > 59) return null;

  // Reject dates that rolled over (Feb 31 → Mar 3).
  const rolled = new Date(Date.UTC(year, month - 1, day));
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) return null;

  return new Date(zoneInstant({ year, month: month - 1, day, hour, minute, second: seconds }, zone));
}

/**
 * POSIX Y2K window for the 10-digit form, and "current year" for the 8-digit
 * form: 69-99 → 1969-1999, 00-68 → 2000-2068.
 */
function yearFrom(digits: string, zone: string): number {
  if (digits.length === 8) return wallClock(Date.now(), zone).year;
  if (digits.length === 12) return Number(digits.slice(0, 4));
  const short = Number(digits.slice(0, 2));
  return short >= 69 ? 1900 + short : 2000 + short;
}

interface State {
  /** Parsed `-t` value. */
  timestamp?: Date;
  /** `-r` reference file, resolved after the walk. */
  reference?: string;
  noCreate: boolean;
  files: string[];
  /** A flag that needs the timestamp, so the shim owns the command. */
  wantsTime: boolean;
  /** Let the original command run: it understands this argument list. */
  passthrough: boolean;
  error?: ExecResult;
}

function optionError(flag: string): ExecResult {
  return { stdout: '', stderr: `touch: option requires an argument -- '${flag}'\n`, exitCode: 1 };
}

/** `-t STAMP`: parse now, so a bad stamp is reported before any file is touched. */
function applyStamp(state: State, value: string, zone: string): void {
  const parsed = parseTouchStamp(value, zone);
  if (parsed) {
    state.timestamp = parsed;
    state.wantsTime = true;
    return;
  }
  state.error = { stdout: '', stderr: `touch: invalid date format '${value}'\n`, exitCode: 1 };
}

/** One `--long` option. Returns the next argument index. */
function longOption(state: State, arg: string, args: string[], at: number): number {
  if (arg === '--no-create') {
    state.noCreate = true;
    return at + 1;
  }
  if (arg === '--reference') {
    const value = args[at + 1];
    if (value === undefined) {
      state.error = optionError('r');
      return at + 1;
    }
    state.reference = value;
    state.wantsTime = true;
    return at + 2;
  }
  if (arg.startsWith('--reference=')) {
    state.reference = arg.slice('--reference='.length);
    state.wantsTime = true;
    return at + 1;
  }
  // `-d` already works in the original command; anything unknown is its call.
  state.passthrough = true;
  return at + 1;
}

/**
 * Value of a short option that takes one: the rest of the bundle (`-t2020…`)
 * or the next argument, plus the index to continue from.
 */
function shortValue(
  arg: string,
  index: number,
  args: string[],
  at: number,
): { value: string; next: number } | undefined {
  const inline = arg.slice(index + 1);
  if (inline !== '') return { value: inline, next: at + 1 };
  const value = args[at + 1];
  return value === undefined ? undefined : { value, next: at + 2 };
}

/** One `-abc` bundle. Returns the next argument index. */
function shortBundle(state: State, arg: string, args: string[], at: number, zone: string): number {
  for (let index = 1; index < arg.length; index += 1) {
    const char = arg[index]!;
    if (char === 'c') {
      state.noCreate = true;
      continue;
    }
    if (char === 'a' || char === 'm') continue;
    // `-d` and every unknown letter belong to the original command.
    if (char !== 't' && char !== 'r') {
      state.passthrough = true;
      return at + 1;
    }
    const short = shortValue(arg, index, args, at);
    if (!short) {
      state.error = optionError(char);
      return at + 1;
    }
    if (char === 't') applyStamp(state, short.value, zone);
    else {
      state.reference = short.value;
      state.wantsTime = true;
    }
    return short.next;
  }
  return at + 1;
}

function parse(args: string[], zone: string): State {
  const state: State = { noCreate: false, files: [], wantsTime: false, passthrough: false };

  let i = 0;
  while (i < args.length && !state.error && !state.passthrough) {
    const arg = args[i]!;
    if (arg === '--') {
      state.files.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-t') {
      const value = args[i + 1];
      if (value === undefined) state.error = optionError('t');
      else applyStamp(state, value, zone);
      i += 2;
      continue;
    }
    if (arg.startsWith('--')) {
      i = longOption(state, arg, args, i);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      i = shortBundle(state, arg, args, i, zone);
      continue;
    }
    state.files.push(arg);
    i += 1;
  }

  return state;
}

async function readReference(
  ctx: ResolvedCommandContext,
  file: string,
): Promise<{ timeMs?: number; error?: ExecResult }> {
  try {
    const stat = await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, file));
    // Read the instant now: the context membrane hands out a proxy, and a proxy
    // outliving the invocation is exactly what its revocation is for.
    return { timeMs: stat.mtime.getTime() };
  } catch {
    return {
      error: {
        stdout: '',
        stderr: `touch: failed to get attributes of '${file}': No such file or directory\n`,
        exitCode: 1,
      },
    };
  }
}

async function apply(
  files: string[],
  timeMs: number,
  noCreate: boolean,
  ctx: ResolvedCommandContext,
): Promise<ExecResult> {
  if (files.length === 0) return { stdout: '', stderr: 'touch: missing file operand\n', exitCode: 1 };

  // A fresh Date: the value must not carry the invocation's proxy into storage.
  const timestamp = new Date(timeMs);
  let failed = false;
  let stderr = '';

  for (const file of files) {
    const path = ctx.fs.resolvePath(ctx.cwd, file);
    try {
      if (!(await ctx.fs.exists(path))) {
        if (noCreate) continue;
        await ctx.fs.writeFile(path, '');
      }
      await ctx.fs.utimes(path, timestamp, timestamp);
    } catch (error) {
      failed = true;
      stderr += `touch: cannot touch '${file}': ${error instanceof Error ? error.message : String(error)}\n`;
    }
  }

  return { stdout: '', stderr, exitCode: failed ? 1 : 0 };
}

export function createTouchCommand() {
  return defineCommand('touch', async (args, ctx) => {
    const original = ctx.origCommand;
    if (!original) return { stdout: '', stderr: 'touch: command is not available\n', exitCode: 127 };

    const state = parse(args, zoneFrom(ctx.env.get('TZ')));
    if (state.error) return state.error;
    if (state.passthrough || !state.wantsTime) return original(args);
    if (typeof ctx.fs.utimes !== 'function') return original(args);

    if (state.timestamp) return apply(state.files, state.timestamp.getTime(), state.noCreate, ctx);
    if (state.reference === undefined) return original(args);

    const reference = await readReference(ctx, state.reference);
    if (reference.error) return reference.error;
    if (reference.timeMs === undefined) return original(args);
    return apply(state.files, reference.timeMs, state.noCreate, ctx);
  });
}

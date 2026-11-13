/**
 * `stat` — complete the `-c`/`--format` directive table.
 *
 * just-bash's `stat` supports ten directives and echoes everything else
 * verbatim, so `stat -c %Y file` printed the literal string `%Y` and exited 0.
 * A wrong answer that looks like success is the worst failure mode for a script,
 * so this wrapper owns the formatter: it accepts GNU's directives, renders the
 * ones the filesystem cannot know from the metadata it does provide, and prints
 * `?` for the rest the way GNU does.
 *
 * Three values are synthetic rather than measured, because the flat storage
 * model has no field for them: `%i` is a stable hash of the path, `%d`/`%D` are
 * zero (there is one device), and `%x`/`%z` mirror the mtime (no atime/ctime is
 * recorded). They are listed in the tables below so the approximation is
 * visible instead of spread through a switch.
 *
 * Without `-c`/`--format`/`--printf` the original command runs unchanged, so the
 * default multi-line output keeps its current shape.
 */

import { defineCommand, type ExecResult, type FsStat, type ResolvedCommandContext } from 'just-bash/browser';

/** Rendered for a directive that has no value here (GNU prints `?`). */
const UNKNOWN = '?';

function symbolicMode(mode: number, isDirectory: boolean): string {
  const bits = ['r', 'w', 'x'];
  let out = isDirectory ? 'd' : '-';
  for (let shift = 6; shift >= 0; shift -= 3) {
    const chunk = (mode >> shift) & 0o7;
    for (let bit = 0; bit < 3; bit += 1) out += chunk & (1 << (2 - bit)) ? bits[bit]! : '-';
  }
  return out;
}

/** GNU's `YYYY-MM-DD HH:MM:SS.nnnnnnnnn +0000`; the store keeps milliseconds. */
function humanTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000000 +0000`;
}

function epochSeconds(ms: number): string {
  return String(Math.floor(ms / 1000));
}

/**
 * A stable inode number.
 *
 * The store has no inodes; a hash of the path keeps `%i` stable within and
 * across executions, which is what `sort | uniq` over a file list needs.
 */
function syntheticInode(identity: string | undefined, name: string): string {
  const source = identity ?? name;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return String(hash >>> 0);
}

function fileType(stat: FsStat): string {
  if (stat.isDirectory) return 'directory';
  if (stat.isSymbolicLink) return 'symbolic link';
  return stat.size === 0 ? 'regular empty file' : 'regular file';
}

interface Directive {
  value: string;
  /** Numeric values accept a precision (`%.3s`); text ones ignore it. */
  numeric?: boolean;
}

interface Target {
  name: string;
  stat: FsStat;
  mtimeMs: number;
}

/** Directives whose value never depends on the file. */
const CONSTANT: Record<string, Directive> = {
  B: { value: '512', numeric: true },
  o: { value: '4096', numeric: true },
  u: { value: '1000', numeric: true },
  U: { value: 'user' },
  g: { value: '1000', numeric: true },
  G: { value: 'user' },
  h: { value: '1', numeric: true },
  // One device, one mount point, no SELinux context.
  d: { value: '0', numeric: true },
  D: { value: '0', numeric: true },
  t: { value: '0', numeric: true },
  T: { value: '0', numeric: true },
  r: { value: '0', numeric: true },
  m: { value: '/' },
  C: { value: '' },
  '%': { value: '%' },
};

/** Times the store does not record; the mtime stands in for all of them. */
const HUMAN_TIME = new Set(['x', 'y', 'z', 'w']);
const EPOCH_TIME = new Set(['X', 'Y', 'Z', 'W']);

/** Directives that need the file itself. */
const FROM_FILE: Record<string, (target: Target) => Directive> = {
  n: ({ name }) => ({ value: name }),
  N: ({ name }) => ({ value: `'${name}'` }),
  s: ({ stat }) => ({ value: String(stat.size), numeric: true }),
  b: ({ stat }) => ({ value: String(Math.ceil(stat.size / 512)), numeric: true }),
  F: ({ stat }) => ({ value: fileType(stat) }),
  a: ({ stat }) => ({ value: (stat.mode & 0o7777).toString(8), numeric: true }),
  A: ({ stat }) => ({ value: symbolicMode(stat.mode, stat.isDirectory) }),
  f: ({ stat }) => ({ value: stat.mode.toString(16), numeric: true }),
  i: ({ stat, name }) => ({ value: syntheticInode(stat.identity, name), numeric: true }),
};

function directive(char: string, target: Target): Directive {
  const constant = CONSTANT[char];
  if (constant) return constant;
  if (HUMAN_TIME.has(char)) return { value: humanTime(target.mtimeMs) };
  if (EPOCH_TIME.has(char)) return { value: epochSeconds(target.mtimeMs), numeric: true };
  return FROM_FILE[char]?.(target) ?? { value: UNKNOWN };
}

const DIRECTIVE_PATTERN = /^(-)?(\d+)?(?:\.(\d+))?([A-Za-z%])/;

/**
 * printf's precision: a minimum number of digits for numbers (`%.3s` → `006`),
 * a maximum length for text.
 */
function applyPrecision(text: string, precision: number, numeric: boolean): string {
  if (!numeric) return text.slice(0, precision);
  return /^\d+$/.test(text) ? text.padStart(precision, '0') : text;
}

/** Render one format string. Supports `%[-][width][.precision]X` like GNU. */
function render(format: string, target: Target): string {
  let out = '';
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '%') {
      out += format[i];
      continue;
    }
    const match = DIRECTIVE_PATTERN.exec(format.slice(i + 1));
    if (!match) {
      // A trailing `%` is printed as-is by GNU.
      out += '%';
      break;
    }
    const [whole, leftAlign, width, precision, spec] = match;
    i += whole.length;

    const resolved = directive(spec!, target);
    let text = resolved.value;
    if (precision !== undefined) text = applyPrecision(text, Number(precision), resolved.numeric === true);
    if (width !== undefined) text = leftAlign ? text.padEnd(Number(width)) : text.padStart(Number(width));
    out += text;
  }
  return out;
}

interface FormatRequest {
  format: string;
  printf: boolean;
  files: string[];
}

/** One `-c`/`--format`/`--printf` occurrence, or `undefined` when absent. */
function formatOption(
  arg: string,
  args: string[],
  at: number,
): { format: string; printf: boolean; next: number } | undefined {
  const reading = arg === '-c' || arg === '--format' || arg === '--printf';
  if (reading) {
    const value = args[at + 1];
    if (value === undefined) return undefined;
    return { format: value, printf: arg === '--printf', next: at + 2 };
  }
  const prefixed = arg.startsWith('--printf=')
    ? { format: arg.slice('--printf='.length), printf: true }
    : arg.startsWith('--format=')
      ? { format: arg.slice('--format='.length), printf: false }
      : undefined;
  return prefixed ? { ...prefixed, next: at + 1 } : undefined;
}

/** Locate `-c`/`--format`/`--printf` and the operands, or bail out. */
function parse(args: string[]): FormatRequest | undefined {
  let format: string | undefined;
  let printf = false;
  const files: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    const option = formatOption(arg, args, i);
    if (option) {
      format = option.format;
      printf = option.printf;
      i = option.next;
      continue;
    }
    // There are no symlinks in this filesystem, so `-L` is a no-op rather than
    // an unknown option. Any other option is the original command's business.
    if (arg === '-L' || arg === '--dereference') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) return undefined;
    files.push(arg);
    i += 1;
  }

  if (format === undefined) return undefined;
  return { format, printf, files };
}

/** `--printf` interprets backslash escapes and omits the trailing newline. */
const BACKSLASH: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  '"': '"',
};

function unescape(format: string): string {
  return format.replace(/\\([abfnrtv0\\"])/g, (_match, char: string) => BACKSLASH[char] ?? char);
}

async function statOf(
  ctx: ResolvedCommandContext,
  file: string,
): Promise<{ stat: FsStat; mtimeMs: number } | undefined> {
  try {
    const stat = await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, file));
    // Read the instant while the context is alive: the `mtime` it hands back is
    // a proxy that must not outlive this invocation.
    return { stat, mtimeMs: stat.mtime.getTime() };
  } catch {
    return undefined;
  }
}

export function createStatCommand() {
  return defineCommand('stat', async (args, ctx) => {
    const original = ctx.origCommand;
    if (!original) return { stdout: '', stderr: 'stat: command is not available\n', exitCode: 127 };

    const request = parse(args);
    if (!request) return original(args);
    if (request.files.length === 0) return { stdout: '', stderr: 'stat: missing operand\n', exitCode: 1 };

    const format = request.printf ? unescape(request.format) : request.format;
    let stdout = '';
    let stderr = '';

    for (const file of request.files) {
      const resolved = await statOf(ctx, file);
      if (!resolved) {
        stderr += `stat: cannot stat '${file}': No such file or directory\n`;
        continue;
      }
      stdout += render(format, { name: file, stat: resolved.stat, mtimeMs: resolved.mtimeMs });
      if (!request.printf) stdout += '\n';
    }

    const result: ExecResult = { stdout, stderr, exitCode: stderr === '' ? 0 : 1 };
    return result;
  });
}

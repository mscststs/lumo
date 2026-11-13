/**
 * `jq` — a thin shim over just-bash's jq for the CLI features the interpreter
 * does not implement.
 *
 * Everything about the *query language* stays in just-bash: this wrapper only
 * rewrites the argument list and then hands it to the original command through
 * `ctx.origCommand`, which is the documented extension point for shadowing a
 * bundled command. The rewrite is driven by one left-to-right scan that mirrors
 * jq's own grammar (options, then the filter, then input files), so a flag value
 * that happens to look like an option (`--arg x -h`) is never mistaken for one.
 *
 * Two features are added:
 *
 *  - `-f` / `--from-file`: read the filter from the VFS. The file contents are
 *    inlined as the filter argument, which is exactly what jq does internally.
 *  - `--version` / `-h`: answer the version and route short help to the long
 *    flag the interpreter does implement.
 *
 * A prelude is prepended to filters that use one of the ISO-8601 aliases jq has
 * and just-bash does not. Only those filters pay for it, so a parse error in any
 * other filter still reports the position in the user's own text. This works
 * only for names the interpreter lacks: just-bash resolves its own builtins
 * before user definitions (real jq does the opposite), so `strftime`, `unique`,
 * `@sh` and `INDEX` cannot be overridden from a prelude and are left alone.
 *
 * Delete the whole file once upstream ships `-f`, `--version` and
 * `fromdateiso8601`/`todateiso8601` (issues #700, #694).
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';

/** What `jq --version` reports: a 1.7-compatible subset as a Lumo build. */
const JQ_VERSION = 'jq-1.7.1-lumo';

/**
 * Query-level definitions injected ahead of the user's filter.
 *
 * Kept on a single line so a multi-line filter keeps its own line numbers in
 * error messages; only line 1's columns shift.
 */
const PRELUDE =
  'def fromdateiso8601: fromdate; def todateiso8601: todate; def toarray: if type == "array" then . else [.] end;';

/**
 * Names the prelude provides.
 *
 * A filter that does not mention one of them is passed through untouched, which
 * keeps just-bash's parse-error positions pointing at the user's own text.
 */
const PRELUDE_NAMES = /\b(?:fromdateiso8601|todateiso8601|toarray)\b/;

function withPrelude(filter: string): string {
  return PRELUDE_NAMES.test(filter) ? `${PRELUDE} ${filter}` : filter;
}

/** Flags that consume **two** arguments (`--arg NAME VALUE`). */
const TWO_VALUE_FLAGS = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile', '--argfile']);

/** Flags that consume one argument. */
const ONE_VALUE_FLAGS = new Set(['-L', '--indent']);

const VERSION_FLAGS = new Set(['--version', '-V']);
const HELP_FLAGS = new Set(['--help', '-h']);
const POSITIONAL_FLAGS = new Set(['--args', '--jsonargs']);

interface Plan {
  /** The argument list with `-f FILE` removed. */
  args: string[];
  /** Position of the filter in {@link args}, or `-1` when there is none. */
  filterIndex: number;
  filterFile?: string;
  version: boolean;
  help: boolean;
  error?: ExecResult;
}

function missingValue(flag: string): ExecResult {
  return {
    stdout: '',
    stderr: `jq: option requires an argument -- '${flag.replace(/^--?/, '')}'\n`,
    exitCode: 2,
  };
}

/**
 * Read a `-f`/`--from-file` occurrence at `at`.
 *
 * Accepts the standalone flag, the long form with `=`, and a short bundle such
 * as `-rf FILE` (where the bundle keeps its other letters).
 */
function takeFilterFile(
  args: string[],
  at: number,
): { file: string; next: number; leading?: string } | { error: ExecResult } | undefined {
  const arg = args[at]!;
  const next = args[at + 1];

  if (arg === '-f' || arg === '--from-file') {
    if (next === undefined) return { error: missingValue('f') };
    return { file: next, next: at + 2 };
  }
  if (arg.startsWith('--from-file=')) {
    return { file: arg.slice('--from-file='.length), next: at + 1 };
  }
  if (!/^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) return undefined;

  const inline = arg.slice(arg.indexOf('f') + 1);
  if (inline === '') {
    if (next === undefined) return { error: missingValue('f') };
    const leading = arg.slice(0, arg.indexOf('f'));
    return {
      file: next,
      next: at + 2,
      ...(leading === '-' ? {} : { leading }),
    };
  }
  const leading = arg.slice(0, arg.indexOf('f'));
  return { file: inline, next: at + 1, ...(leading === '-' ? {} : { leading }) };
}

/** `--arg NAME VALUE` and friends: copy the flag and its operands verbatim. */
function optionValues(
  arg: string,
  args: string[],
  at: number,
): { next: number } | { error: ExecResult } | undefined {
  const count = TWO_VALUE_FLAGS.has(arg) ? 2 : ONE_VALUE_FLAGS.has(arg) ? 1 : 0;
  if (count === 0) return undefined;
  if (at + count >= args.length) return { error: missingValue(arg) };
  return { next: at + count + 1 };
}

/** Walk the argument list once, in jq's own order. */
function plan(args: string[]): Plan {
  const out: string[] = [];
  let filterIndex = -1;
  let filterFile: string | undefined;
  let version = false;
  let help = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    const filter = takeFilterFile(args, i);
    if (filter && 'error' in filter) return { args: out, filterIndex, version, help, error: filter.error };
    if (filter) {
      filterFile = filter.file;
      if (filter.leading) out.push(filter.leading);
      i = filter.next;
      continue;
    }

    if (arg === '--') {
      if (i + 1 < args.length) {
        filterIndex = out.length + 1;
        out.push(...args.slice(i));
      }
      break;
    }
    if (POSITIONAL_FLAGS.has(arg)) {
      out.push(...args.slice(i));
      break;
    }
    const values = optionValues(arg, args, i);
    if (values && 'error' in values) {
      return { args: out, filterIndex, version, help, error: values.error };
    }
    if (values) {
      out.push(...args.slice(i, values.next));
      i = values.next;
      continue;
    }
    if (VERSION_FLAGS.has(arg)) {
      version = true;
      i += 1;
      continue;
    }
    if (HELP_FLAGS.has(arg)) {
      help = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      out.push(arg);
      i += 1;
      continue;
    }

    // The filter. Everything after it is an input file or `--args` value.
    filterIndex = out.length;
    out.push(...args.slice(i));
    break;
  }

  return { args: out, filterIndex, version, help, ...(filterFile !== undefined ? { filterFile } : {}) };
}

async function readFilter(
  ctx: ResolvedCommandContext,
  file: string,
): Promise<{ program: string } | { error: ExecResult }> {
  try {
    const text = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file), 'utf8');
    return { program: withPrelude(text) };
  } catch {
    return {
      error: {
        stdout: '',
        stderr: `jq: error: Could not open ${file}: No such file or directory\n`,
        exitCode: 2,
      },
    };
  }
}

export function createJqCommand() {
  return defineCommand('jq', async (args, ctx) => {
    const original = ctx.origCommand;
    if (!original) return { stdout: '', stderr: 'jq: command is not available\n', exitCode: 127 };

    const request = plan(args);
    if (request.error) return request.error;
    if (request.version) return { stdout: `${JQ_VERSION}\n`, stderr: '', exitCode: 0 };
    if (request.help) return original(['--help']);

    const out = request.args;

    if (request.filterFile !== undefined) {
      // `-f -` would have to consume stdin as the program *and* leave the data
      // stream for the filter to read; the interpreter has no second stream, so
      // say so instead of silently reading the wrong thing.
      if (request.filterFile === '-') {
        return {
          stdout: '',
          stderr: 'jq: error: -f - (filter from stdin) is not supported; write the filter to a file\n',
          exitCode: 2,
        };
      }
      const read = await readFilter(ctx, request.filterFile);
      if ('error' in read) return read.error;
      // Insert where the filter belongs: after the options, before the input
      // files, so `jq -f prog.jq -r data.json` keeps working.
      if (request.filterIndex === -1) out.push(read.program);
      else out.splice(request.filterIndex, 0, read.program);
    } else if (request.filterIndex !== -1) {
      out[request.filterIndex] = withPrelude(out[request.filterIndex]!);
    }

    return original(out);
  });
}

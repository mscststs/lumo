/**
 * `which` — resolve commands against the interpreter's registry too.
 *
 * just-bash's `which` only looks for executable files under `$PATH`. The
 * bundled commands have no such files, so with the extension's async filesystem
 * (which never gets just-bash's `/bin` stub layout) `which jq` printed nothing
 * and exited 1 even though `jq` runs. Scripts use `which` as a capability probe,
 * so the false negative is worse than the usual `command -v` false positive.
 *
 * Resolution mirrors the interpreter: a real file under `$PATH` wins, then the
 * command registry.
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';

const DEFAULT_PATH = '/usr/bin:/bin';

async function isExecutable(ctx: ResolvedCommandContext, path: string): Promise<boolean> {
  try {
    const stat = await ctx.fs.stat(path);
    return !stat.isDirectory && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Where `$PATH` and the registry would send `name`, in dispatch order. */
async function locate(
  ctx: ResolvedCommandContext,
  name: string,
  registered: ReadonlySet<string>,
): Promise<string | undefined> {
  // A word containing a slash names a path, not a PATH entry.
  if (name.includes('/')) {
    return (await isExecutable(ctx, ctx.fs.resolvePath(ctx.cwd, name))) ? name : undefined;
  }

  for (const dir of (ctx.env.get('PATH') ?? DEFAULT_PATH).split(':')) {
    if (!dir) continue;
    if (await isExecutable(ctx, ctx.fs.resolvePath(dir, name))) return `${dir}/${name}`;
  }
  return registered.has(name) ? `/usr/bin/${name}` : undefined;
}

interface Parsed {
  silent: boolean;
  names: string[];
  delegate: boolean;
}

function parse(args: string[]): Parsed {
  let silent = false;
  const names: string[] = [];

  for (const arg of args) {
    if (arg === '--') continue;
    if (arg === '--help') return { silent, names, delegate: true };
    if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
      for (const char of arg.slice(1)) {
        // `-a` lists every match; a registry command has exactly one path, and
        // a file on $PATH is reported once, so it needs no separate branch.
        if (char === 's') silent = true;
        else if (char !== 'a') return { silent, names, delegate: true };
      }
      continue;
    }
    names.push(arg);
  }

  return { silent, names, delegate: false };
}

export function createWhichCommand() {
  return defineCommand('which', async (args, ctx) => {
    const original = ctx.origCommand;
    if (!original) return { stdout: '', stderr: 'which: command is not available\n', exitCode: 127 };

    const parsed = parse(args);
    if (parsed.delegate) return original(args);
    if (parsed.names.length === 0) return { stdout: '', stderr: '', exitCode: 1 };

    const registered = new Set(ctx.getRegisteredCommands?.() ?? []);
    let stdout = '';
    let found = 0;

    for (const name of parsed.names) {
      const located = await locate(ctx, name, registered);
      if (located === undefined) continue;
      found += 1;
      if (!parsed.silent) stdout += `${located}\n`;
    }

    const result: ExecResult = { stdout, stderr: '', exitCode: found === parsed.names.length ? 0 : 1 };
    return result;
  });
}

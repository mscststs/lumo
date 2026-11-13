/**
 * Regression tests for the extension-point shims in `lib/shell/compat`.
 *
 * Every block is named after the defect it closes, in the same `E3-*` style the
 * other shell suites use, and asserts the *GNU* answer — the value a script
 * would have got from a real `jq`/`coreutils` binary:
 *
 *   E3-1  jq --version / -f / missing date aliases
 *   E3-2  stat -c directives (was: printed the directive literally)
 *   E3-3  date -r and relative -d
 *   E3-4  which resolves registry commands
 *   E3-5  touch -t / -r actually set the mtime
 *   E3-6  uname / ps describe the sandbox
 *   E3-7  virtual /etc and /proc files
 *   E3-8  node reports a version a script can gate on
 */

import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Bash } from 'just-bash/browser';
import type { SecureFetch } from 'just-bash';
import { fileStorage } from '@/lib/mcp/file-storage';
import { LumoFileSystem } from '@/lib/shell/vfs';
import { createCompatCommands } from '@/lib/shell/compat';
import { createNodeCommand } from '@/lib/shell/node-command';
import { executeShell } from '@/lib/shell/runtime/execute';
import { NODE_VERSION } from '@/lib/shell/system-facts';

const originalFetch = globalThis.fetch;

beforeAll(() => {
  // `node` loads the QuickJS wasm from the dev server; read it off disk instead.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('.wasm')) {
      return new Response(await readFile(`.${url}`), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await fileStorage.clearFiles();
});

async function shell(options: { fetch?: SecureFetch } = {}): Promise<Bash> {
  const fs = new LumoFileSystem();
  await fs.refresh();
  const bash = new Bash({
    fs,
    cwd: '/',
    env: { TZ: 'Asia/Shanghai' },
    customCommands: [...createCompatCommands(), createNodeCommand()],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: 30_000 },
  });
  return bash;
}

describe('E3-1 jq CLI surface', () => {
  it('answers --version and -V', async () => {
    const bash = await shell();
    expect((await bash.exec('jq --version')).stdout).toMatch(/^jq-1\.\d+\.\d+-lumo\n$/);
    expect((await bash.exec('jq -V')).stdout).toBe((await bash.exec('jq --version')).stdout);
  });

  it('reads the filter from a file with -f', async () => {
    const bash = await shell();
    const result = await bash.exec("printf 'def double: . * 2;\\ndouble\\n' > /prog.jq; echo 3 | jq -f /prog.jq");
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('6\n');
    expect(result.exitCode).toBe(0);
  });

  it('handles -f in a short bundle and after other flags', async () => {
    const bash = await shell();
    const result = await bash.exec("printf '.a\\n' > /p.jq; echo '{\"a\":7}' | jq -r -f /p.jq");
    expect(result.stdout).toBe('7\n');
    expect((await bash.exec("printf '.a\\n' > /q.jq; echo '{\"a\":8}' | jq -rf /q.jq")).stdout).toBe('8\n');
  });

  it('reports a missing filter file like jq', async () => {
    const bash = await shell();
    const result = await bash.exec('echo 1 | jq -f /missing.jq');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Could not open /missing.jq');
  });

  it('supplies the ISO-8601 date aliases', async () => {
    const bash = await shell();
    expect((await bash.exec(`echo '"2026-11-13T10:00:00Z"' | jq 'fromdateiso8601'`)).stdout.trim()).toBe(
      '1794564000',
    );
    expect((await bash.exec(`echo 1794564000 | jq 'todateiso8601'`)).stdout.trim()).toBe(
      '"2026-11-13T10:00:00Z"',
    );
    expect((await bash.exec(`echo 1 | jq 'toarray'`)).stdout.trim()).toBe('[\n  1\n]');
  });

  it('still runs filters that use none of the additions', async () => {
    const bash = await shell();
    const result = await bash.exec(`echo '{"a":[1,2]}' | jq -c '.a | map(. * 2)'`);
    expect(result.stdout).toBe('[2,4]\n');
  });

  it('does not mistake flag values for the filter', async () => {
    const bash = await shell();
    // `--arg NAME VALUE` takes two arguments; treating VALUE as the filter
    // injected the prelude into a string/number and broke the query.
    expect((await bash.exec(`jq -n --arg x 1 '$x'`)).stdout).toBe('"1"\n');
    expect((await bash.exec(`jq -n --argjson a '[1,2]' '$a | length'`)).stdout).toBe('2\n');
    expect((await bash.exec(`printf '1\\n2\\n' | jq -s add`)).stdout).toBe('3\n');
    expect((await bash.exec(`jq -n --args '$ARGS.positional' a b`)).stdout).toBe('[\n  "a",\n  "b"\n]\n');
  });

  it('does not read a flag value as an option', async () => {
    const bash = await shell();
    // Recorded from jq 1.8.1: the value of --arg is data, never a flag.
    expect((await bash.exec(`jq -n --arg x -h '$x'`)).stdout).toBe('"-h"\n');
    expect((await bash.exec(`jq -n --arg x --version '$x'`)).stdout).toBe('"--version"\n');
  });

  it('maps -h onto the long help flag', async () => {
    const bash = await shell();
    const result = await bash.exec('jq -h');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('command-line JSON processor');
  });
});

describe('E3-2 stat -c directives', () => {
  it('renders %Y and %y instead of echoing the directive', async () => {
    const bash = await shell();
    const result = await bash.exec('echo hi > /f.txt; stat -c %Y /f.txt');
    expect(result.stdout.trim()).toMatch(/^\d{10,}$/);
    expect((await bash.exec('echo hi > /f.txt; stat -c %y /f.txt')).stdout.trim()).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9} \+0000$/,
    );
  });

  it('renders the metadata directives', async () => {
    const bash = await shell();
    const result = await bash.exec('printf abc > /s.txt; stat -c "%n %s %F %a %A %h" /s.txt');
    expect(result.stdout.trim()).toBe('/s.txt 3 regular file 644 -rw-r--r-- 1');
  });

  it('keeps %Y consistent with date -r', async () => {
    const bash = await shell();
    const result = await bash.exec('echo x > /d.txt; echo "$(stat -c %Y /d.txt) $(date -r /d.txt +%s)"');
    const [fromStat, fromDate] = result.stdout.trim().split(' ');
    expect(fromDate).toBe(fromStat);
  });

  it('renders --printf without a trailing newline', async () => {
    const bash = await shell();
    const printed = await bash.exec('printf abc > /p.txt; stat --printf "%s:%F\\n" /p.txt');
    expect(printed.stdout).toBe('3:regular file\n');
    const bare = await bash.exec('printf abc > /q.txt; stat --printf %s /q.txt');
    expect(bare.stdout).toBe('3');
  });

  it('delegates when no format is given', async () => {
    const bash = await shell();
    const result = await bash.exec('echo x > /plain.txt; stat /plain.txt');
    expect(result.stdout).toContain('File: /plain.txt');
    expect(result.stdout).toContain('Modify:');
  });
});

describe('E3-3 date', () => {
  it('reads a file mtime with -r', async () => {
    const bash = await shell();
    await bash.exec('echo x > /r.txt; touch -t 202001020304 /r.txt');
    // `-t` is local time in $TZ (the harness sets Asia/Shanghai), so the same
    // zone reads the stamp back unchanged.
    const result = await bash.exec('date -r /r.txt +%Y-%m-%dT%H:%M:%S');
    expect(result.stdout.trim()).toBe('2020-01-02T03:04:00');
  });

  it('accepts GNU relative expressions', async () => {
    const bash = await shell();
    const tomorrow = await bash.exec('date -d tomorrow +%F');
    const plusOne = await bash.exec('date -d "+1 day" +%F');
    expect(plusOne.stdout).toBe(tomorrow.stdout);

    const twoDaysAgo = await bash.exec('date -d "2 days ago" +%s');
    const minusTwo = await bash.exec('date -d "-2 days" +%s');
    expect(twoDaysAgo.stdout).toBe(minusTwo.stdout);

    const nextMonday = await bash.exec('date -d "next monday" +%u');
    expect(nextMonday.stdout.trim()).toBe('1');
  });

  it('zeroes the time for weekday names, like GNU', async () => {
    const bash = await shell();
    // Asserted as invariants, not fixed dates: the weekday and the time of day
    // are what GNU guarantees, and a hardcoded date would expire.
    const monday = (await bash.exec('date -u -d "next monday" "+%u %T"')).stdout.trim();
    expect(monday).toBe('1 00:00:00');
    expect((await bash.exec('date -u -d "last friday" "+%u %T"')).stdout.trim()).toBe('5 00:00:00');
    expect((await bash.exec('date -u -d "this sunday" "+%u %T"')).stdout.trim()).toBe('7 00:00:00');

    const now = Number((await bash.exec('date -u +%s')).stdout.trim());
    const next = Number((await bash.exec('date -u -d "next monday" +%s')).stdout.trim());
    const days = (next - now) / 86_400;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(7);
  });

  it('overflows months the way mktime does', async () => {
    const bash = await shell();
    // Jan 31 + 1 month is Mar 3, not Feb 28.
    expect((await bash.exec('date -u -d "2026-01-31 +1 month" +%F')).stdout.trim()).toBe('2026-03-03');
    expect((await bash.exec('date -u -d "2024-02-29 +1 year" +%F')).stdout.trim()).toBe('2025-03-01');
  });

  it('does relative arithmetic on the wall clock, not in epoch millis', async () => {
    const bash = await shell();
    // 2026-03-08 12:00 EST + 1 day is 2026-03-09 12:00 EDT: 23 absolute hours.
    const acrossDst = await bash.exec('TZ=America/New_York date -d "2026-03-08 12:00 +1 day" "+%F %T %s"');
    expect(acrossDst.stdout.trim()).toBe('2026-03-09 12:00:00 1773072000');
    const localBase = await bash.exec('TZ=Asia/Shanghai date -d "2026-11-13 +1 day" "+%F %T"');
    expect(localBase.stdout.trim()).toBe('2026-11-14 00:00:00');
  });

  it('leaves everything it does not understand to the original command', async () => {
    const bash = await shell();
    expect((await bash.exec('date -u -d @1700000000 +%F')).stdout.trim()).toBe('2023-11-14');
    expect((await bash.exec('date -u -d "2026-11-13T10:00:00Z" +%H')).stdout.trim()).toBe('10');
  });

  it('reports a missing reference file', async () => {
    const bash = await shell();
    const result = await bash.exec('date -r /nope.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No such file or directory');
  });
});

describe('E3-4 which', () => {
  it('resolves bundled commands that have no file on disk', async () => {
    const bash = await shell();
    const result = await bash.exec('which jq');
    expect(result.stdout).toBe('/usr/bin/jq\n');
    expect(result.exitCode).toBe(0);
  });

  it('prefers a real file on $PATH and still fails for unknown names', async () => {
    const bash = await shell();
    await bash.exec('mkdir -p /bin && printf "#!/bin/sh\\nexit 0\\n" > /bin/custom && chmod +x /bin/custom');
    expect((await bash.exec('PATH=/bin:$PATH which custom')).stdout.trim()).toBe('/bin/custom');
    expect((await bash.exec('which not-a-command')).exitCode).toBe(1);
  });

  it('honours -s', async () => {
    const bash = await shell();
    const result = await bash.exec('which -s jq');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

describe('E3-5 touch', () => {
  it('applies -t instead of ignoring it', async () => {
    const bash = await shell();
    const result = await bash.exec('echo x > /t.txt; touch -t 202001020304 /t.txt; date -r /t.txt "+%F %T"');
    expect(result.stdout.trim()).toBe('2020-01-02 03:04:00');
  });

  it('reads -t as local time in $TZ', async () => {
    const bash = await shell();
    // Recorded from GNU touch/date: the stamp has no offset, so the epoch
    // depends on the zone.
    const utc = await bash.exec('TZ=UTC touch -t 202001020304 /u.txt; TZ=UTC date -r /u.txt +%s');
    expect(utc.stdout.trim()).toBe('1577934240');
    const shanghai = await bash.exec('TZ=Asia/Shanghai touch -t 202001020304 /s.txt; TZ=Asia/Shanghai date -r /s.txt +%s');
    expect(shanghai.stdout.trim()).toBe('1577905440');
  });

  it('applies -r from another file', async () => {
    const bash = await shell();
    const result = await bash.exec(
      'echo a > /a.txt; touch -t 202105060708 /a.txt; echo b > /b.txt; touch -r /a.txt /b.txt; date -r /b.txt +%F',
    );
    expect(result.stdout.trim()).toBe('2021-05-06');
  });

  it('creates missing files and respects -c', async () => {
    const bash = await shell();
    const created = await bash.exec('touch -t 202001020304 /new.txt; test -f /new.txt && echo yes');
    expect(created.stdout.trim()).toBe('yes');

    const skipped = await bash.exec('touch -c -t 202001020304 /absent.txt; test -f /absent.txt || echo absent');
    expect(skipped.stdout.trim()).toBe('absent');
  });

  it('rejects a malformed -t value', async () => {
    const bash = await shell();
    const result = await bash.exec('touch -t nope /x.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid date format');
  });
});

describe('E3-6 platform probes', () => {
  it('answers uname', async () => {
    const bash = await shell();
    expect((await bash.exec('uname -s')).stdout).toBe('Linux\n');
    expect((await bash.exec('uname -m')).stdout).toBe('x86_64\n');
    const all = await bash.exec('uname -a');
    expect(all.stdout).toMatch(/^Linux lumo \S+ #1 SMP PREEMPT x86_64 /);
    expect((await bash.exec('uname')).stdout).toBe('Linux\n');
    expect((await bash.exec('uname -o')).stdout).toBe('GNU/Linux\n');
    expect((await bash.exec('uname --kernel-name')).stdout).toBe('Linux\n');
  });

  it('rejects unknown uname flags', async () => {
    const bash = await shell();
    const result = await bash.exec('uname -Z');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid option -- 'Z'");
  });

  it('answers ps with a process table', async () => {
    const bash = await shell();
    const table = await bash.exec('ps');
    expect(table.stdout.split('\n')[0]).toContain('PID');
    expect(table.stdout).toContain('bash');
    expect((await bash.exec('ps aux')).stdout).toContain('USER');
  });

  it('lets a portable script detect the platform without failing', async () => {
    const bash = await shell();
    const result = await bash.exec('case "$(uname -s)" in Linux) echo linux ;; *) echo other ;; esac');
    expect(result.stdout).toBe('linux\n');
  });
});

describe('E3-7 virtual system files', () => {
  it('serves /etc/os-release and /proc/version', async () => {
    const bash = await shell();
    expect((await bash.exec("grep '^ID=' /etc/os-release")).stdout).toBe('ID=lumo\n');
    expect((await bash.exec('grep -c "version" /proc/version')).stdout.trim()).toBe('1');
    expect((await bash.exec('test -f /etc/os-release && echo file')).stdout.trim()).toBe('file');
  });

  it('keeps them read-only', async () => {
    const bash = await shell();
    // A failed redirect can surface as a thrown filesystem error rather than an
    // exit code (upstream: `exec` fails on a redirect error); both mean "did not
    // write", which is the property under test.
    const write = await bash.exec('echo x > /etc/os-release').catch((error: Error) => error);
    expect(write).not.toMatchObject({ exitCode: 0 });
    const remove = await bash.exec('rm /etc/os-release').catch((error: Error) => error);
    expect(remove).not.toMatchObject({ exitCode: 0 });
    expect((await bash.exec("grep '^ID=' /etc/os-release")).stdout).toBe('ID=lumo\n');
  });

  it('lists them like a directory and keeps /dev/null working', async () => {
    const bash = await shell();
    expect((await bash.exec('ls /etc')).stdout).toBe('os-release\n');
    expect((await bash.exec('ls /proc')).stdout).toBe('version\n');
    const root = (await bash.exec('ls /')).stdout.split('\n');
    expect(root).toEqual(expect.arrayContaining(['dev', 'etc', 'proc']));
    expect((await bash.exec('echo x > /dev/null && echo ok')).stdout).toBe('ok\n');
    // The virtual tree must not leak into the stored library.
    expect((await bash.exec('ls /')).stdout).not.toContain('null');
  });

  it('exposes them to node through the synchronous bridge', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "node -e \"const fs = require('fs'); console.log(fs.existsSync('/etc/os-release'), fs.readFileSync('/etc/os-release','utf8').includes('ID=lumo'))\"",
    );
    expect(result.stdout).toBe('true true\n');
  });
});

describe('E3-8 node version', () => {
  it('reports a version a script can gate on', async () => {
    const bash = await shell();
    expect((await bash.exec('node --version')).stdout).toBe(`${NODE_VERSION}\n`);
    expect((await bash.exec("node -p 'process.version'")).stdout).toBe(`${NODE_VERSION}\n`);
    expect((await bash.exec("node -p 'process.versions.lumo'")).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('E3-10 real runtime wiring', () => {
  it('registers every shim in the tool runtime', async () => {
    const result = await executeShell({}, {
      command: "uname -s; jq --version; grep '^ID=' /etc/os-release; which jq; uname -m",
    });
    const [kernel, jqVersion, osId, jqPath, machine] = result.stdout.trim().split('\n');
    expect(kernel).toBe('Linux');
    expect(jqVersion).toMatch(/^jq-1\.\d+\.\d+-lumo$/);
    expect(osId).toBe('ID=lumo');
    expect(jqPath).toBe('/usr/bin/jq');
    expect(machine).toBe('x86_64');
    expect(result.exitCode).toBe(0);
  });

  it('does not change a script that uses none of the additions', async () => {
    const result = await executeShell({}, { command: 'echo hi | sed s/hi/there/' });
    expect(result.stdout).toBe('there\n');
    expect(result.stderr).toBe('');
  });
});

describe('E3-9 curl -A warning', () => {
  it('says the header is ignored but leaves the request alone', async () => {
    const requested: string[] = [];
    const fakeFetch: SecureFetch = async (url) => {
      requested.push(url);
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: new TextEncoder().encode('ok'),
        url,
      };
    };

    const bash = await shell({ fetch: fakeFetch });
    const result = await bash.exec('curl -s -A curl/8 https://example.com/hello');
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toContain('-A/--user-agent is ignored');
    expect(requested).toEqual(['https://example.com/hello']);
  });

  it('stays quiet without the flag', async () => {
    const fakeFetch: SecureFetch = async (url) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: new TextEncoder().encode('ok'),
      url,
    });
    const bash = await shell({ fetch: fakeFetch });
    expect((await bash.exec('curl -s https://example.com/')).stderr).toBe('');
  });
});

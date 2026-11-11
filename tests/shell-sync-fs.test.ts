/**
 * Node module loading and the synchronous filesystem.
 *
 * Two defects drove this file:
 *
 *  - `const fs = await import('fs')` failed with "could not load module 'fs'":
 *    only static, whole-line `import` statements were downgraded, so every
 *    dynamic import reached QuickJS's (absent) module loader — and an
 *    unawaited one rejected silently. A one-line `node -e 'import fs from …'`
 *    was a syntax error for the same reason.
 *  - Every `fs.*Sync` call threw "not available": the bytes live in IndexedDB,
 *    so the guest cannot await a read. The `SyncFileBridge` snapshots the tree
 *    before the VM starts and journals mutations, which is what these tests
 *    pin down: Node-shaped results, one filesystem for both APIs, and writes
 *    that survive the script ending.
 */

import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { Bash } from 'just-bash/browser';
import { LumoFileSystem } from '@/lib/shell/vfs';
import { createNodeCommand } from '@/lib/shell/node-command';
import { fileStorage } from '@/lib/mcp/file-storage';

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('.wasm')) {
      const path = url.startsWith('/node_modules/') ? `.${url}` : url;
      return new Response(await readFile(path), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

async function shell(limits: { maxExecutionTimeMs?: number } = {}) {
  const fs = new LumoFileSystem();
  await fs.refresh();
  return new Bash({
    fs,
    cwd: '/',
    env: { TZ: 'Asia/Shanghai' },
    customCommands: [createNodeCommand()],
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: limits.maxExecutionTimeMs ?? 30_000 },
  });
}

/** Run `node -e '<code>'` in a fresh shell. */
async function node(code: string, limits: { maxExecutionTimeMs?: number } = {}) {
  const bash = await shell(limits);
  const escaped = code.replace(/'/g, "'\\''");
  return bash.exec(`node -e '${escaped}'`);
}

describe('dynamic import', () => {
  it('loads a builtin and exposes the ESM namespace', async () => {
    const result = await node(
      "const fs = await import('fs'); console.log(typeof fs.readFileSync, typeof fs.default.readFileSync)",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('function function\n');
  });

  it('returns a promise, so .then and Promise.all work', async () => {
    const result = await node(
      "import('node:path').then((p) => console.log(typeof p.join));" +
        "const [a, b] = await Promise.all([import('path'), import('os')]);" +
        'console.log(typeof a.join, typeof b.hostname)',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('function\nfunction function\n');
  });

  it('resolves a computed specifier', async () => {
    const result = await node("const name = 'node:os'; const os = await import(name); console.log(typeof os.hostname)");
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('function\n');
  });

  it('loads a relative module collected from the VFS', async () => {
    const fs = new LumoFileSystem();
    await fs.refresh();
    await fs.mkdir('/esm', { recursive: true });
    await fs.writeFile('/esm/helper.js', 'module.exports = { greeting: "hi" };\n');
    const bash = await shell();
    const result = await bash.exec(
      `cd /esm && node -e 'const m = await import("./helper.js"); console.log(m.greeting, typeof m.default)'`,
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('hi object\n');
  });

  it('reports an unawaited rejection instead of dropping it', async () => {
    const result = await node("import('no-such-module'); console.log('after')");
    expect(result.stdout).toBe('after\n');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot find module 'no-such-module'");
  });

  it('does not rewrite a property called import', async () => {
    const result = await node(
      "const holder = { ['import']: (value) => value * 2 }; console.log(holder['import'](2))",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('4\n');
  });
});

describe('static import on a single line', () => {
  it('downgrades a one-line `node -e` script', async () => {
    const result = await node("import fs from 'node:fs'; console.log(typeof fs.readFileSync)");
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('function\n');
  });

  it('handles named, namespace and mid-line imports', async () => {
    const result = await node(
      "import { join, basename } from 'node:path'; import * as os from 'node:os';" +
        "const x = 1; import path from 'node:path';" +
        "console.log(join('/a', 'b'), basename('/a/b.txt'), typeof os.hostname, typeof path.sep, x)",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('/a/b b.txt function string 1\n');
  });
});

describe('builtin drift', () => {
  it('resolves path/posix and path/win32', async () => {
    const result = await node(
      "const posix = require('path/posix'); const win = require('path/win32');" +
        "console.log(posix.sep, win.sep, posix.join('a', 'b'))",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('/ \\ a/b\n');
  });

  it('resolves stream/promises', async () => {
    const result = await node(
      "const { pipeline, finished } = require('stream/promises'); console.log(typeof pipeline, typeof finished)",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('function function\n');
  });
});

describe('synchronous fs', () => {
  it('reads and writes like Node', async () => {
    const result = await node(
      "const fs = require('fs');" +
        "fs.writeFileSync('/a.txt', 'hello');" +
        "const text = fs.readFileSync('/a.txt', 'utf8');" +
        'const bytes = fs.readFileSync("/a.txt");' +
        'console.log(text, Buffer.isBuffer(bytes), bytes.length)',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('hello true 5\n');
  });

  it('persists to the shared file store after the script ends', async () => {
    const bash = await shell();
    const result = await bash.exec("node -e 'require(\"fs\").writeFileSync(\"/notes.md\", \"# hi\")'");
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    // The VFS is what the file tools and `cat` read, so this is the real check.
    expect(await fileStorage.readFileAsText('notes.md')).toBe('# hi');
    const cat = await bash.exec('cat /notes.md');
    expect(cat.stdout).toBe('# hi');
  });

  it('answers metadata without loading contents', async () => {
    const fs = new LumoFileSystem();
    await fs.refresh();
    await fs.mkdir('/d/e', { recursive: true });
    await fs.writeFile('/d/e/f.txt', 'x');
    const result = await node(
      [
        "const fs = require('fs');",
        "console.log(fs.existsSync('/d/e/f.txt'), fs.statSync('/d/e/f.txt').isFile(), fs.statSync('/d/e').isDirectory());",
        "console.log(fs.readdirSync('/d/e').join(','));",
        "const [entry] = fs.readdirSync('/d', { withFileTypes: true });",
        'console.log(entry.name, entry.isDirectory(), entry.parentPath);',
      ].join('\n'),
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('true true true\nf.txt\ne true /d\n');
  });

  it('returns the first directory created, like Node', async () => {
    const result = await node(
      "const fs = require('fs');" +
        'console.log(fs.mkdirSync("/m/n", { recursive: true }), fs.mkdirSync("/m/n", { recursive: true }))',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('/m undefined\n');
  });

  it('copies, renames and removes', async () => {
    const result = await node(
      "const fs = require('fs');" +
        "fs.writeFileSync('/x.txt', '1');" +
        "fs.copyFileSync('/x.txt', '/y.txt');" +
        "fs.renameSync('/y.txt', '/z.txt');" +
        "fs.unlinkSync('/x.txt');" +
        "fs.appendFileSync('/z.txt', '2');" +
        "console.log(fs.readFileSync('/z.txt', 'utf8'), fs.existsSync('/x.txt'))",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('12 false\n');
  });

  it('throws Node-shaped errors', async () => {
    const result = await node(
      "const fs = require('fs');" +
        "fs.mkdirSync('/full'); fs.writeFileSync('/full/a', '1');" +
        "const probe = (fn) => { try { fn() } catch (error) { return error.code + ':' + error.syscall } };" +
        "console.log(probe(() => fs.readFileSync('/nope'))," +
        " probe(() => fs.rmdirSync('/full'))," +
        " probe(() => fs.readFileSync('/full'))," +
        ' probe(() => fs.mkdirSync("/full")))',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('ENOENT:open ENOTEMPTY:rmdir EISDIR:read EEXIST:mkdir\n');
  });

  it('honours throwIfNoEntry: false', async () => {
    const result = await node(
      "const fs = require('fs'); console.log(fs.statSync('/absent', { throwIfNoEntry: false }))",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('undefined\n');
  });

  it('reads a file the shell wrote earlier in the same script', async () => {
    // The end-to-end shape of a real `sh` call: a pipeline produces data, the
    // script parses it synchronously.
    const bash = await shell();
    const script = [
      'const fs = await import("fs");',
      'const data = JSON.parse(fs.readFileSync("/hz.json", "utf8"));',
      'console.log(data.weather[0].maxtempC);',
    ].join('');
    const result = await bash.exec(
      `printf '{"weather":[{"maxtempC":"21"}]}' > /hz.json && node -e ${JSON.stringify(script)}`,
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('21\n');
  });

  it('keeps the sync and async APIs on one filesystem', async () => {
    const result = await node(
      "const fs = require('fs');" +
        "fs.writeFileSync('/mixed.txt', 'sync');" +
        "const fromAsync = await fs.promises.readFile('/mixed.txt', 'utf8');" +
        "await fs.writeFile('/mixed2.txt', 'async');" +
        "const fromSync = fs.readFileSync('/mixed2.txt', 'utf8');" +
        'console.log(fromAsync, fromSync)',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('sync async\n');
  });

  it('sees writes across exec in both directions', async () => {
    const result = await node(
      "const fs = require('fs');" +
        "fs.writeFileSync('/from-node.txt', 'node');" +
        "const readBack = await exec('cat /from-node.txt');" +
        "await exec('echo shell > /from-shell.txt');" +
        "console.log(readBack.stdout.trim(), fs.readFileSync('/from-shell.txt', 'utf8').trim())",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('node shell\n');
  });

  it('supports file descriptors', async () => {
    const result = await node(
      "const fs = require('fs');" +
        "fs.writeFileSync('/fd.txt', 'hello');" +
        "const fd = fs.openSync('/fd.txt', 'r');" +
        'const buffer = Buffer.alloc(5);' +
        'fs.readSync(fd, buffer, 0, 5, 0);' +
        'fs.closeSync(fd);' +
        'console.log(buffer.toString(), fs.fstatSync(fs.openSync("/fd.txt")).isFile())',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('hello true\n');
  });

  it('flushes what a script wrote before it was interrupted', async () => {
    const bash = await shell({ maxExecutionTimeMs: 800 });
    const result = await bash.exec("node -e 'require(\"fs\").writeFileSync(\"/partial.txt\", \"kept\"); while (true) {}'");
    expect(result.exitCode).not.toBe(0);
    expect(await fileStorage.readFileAsText('partial.txt')).toBe('kept');
  });

  it('explains a sync read the metadata-only snapshot cannot answer', async () => {
    const fs = new LumoFileSystem();
    await fs.refresh();
    await fs.writeFile('/pre-existing.txt', 'body');
    // The script names no content-read API (the lookup is indirect), so only
    // metadata was snapshotted and the read has to explain itself.
    const result = await node(
      [
        "const fs = require('fs');",
        "console.log(fs.existsSync('/pre-existing.txt'));",
        "const read = fs['readFile' + 'Sync'];",
        "try { read('/pre-existing.txt') } catch (error) { console.log(error.message) }",
      ].join('\n'),
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('true\n');
    expect(result.stdout).toContain('use `await fs.readFile(...)`');
  });
});

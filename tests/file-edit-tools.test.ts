/**
 * End-to-end behaviour of the file editing tools, through the real tool
 * `execute` functions.
 *
 * `file-edit.test.ts` covers the matching engine in isolation. What matters here
 * is the property the old `file_patch` violated at the *storage boundary*: a
 * failed edit must leave the stored file byte-identical and must not report
 * success. The old applier wrote a corrupted file and returned
 * `{ success: true }` for stale line numbers, mismatched removal lines, and
 * patches with no `@@` header at all.
 *
 * `fileStorage` is stubbed with an in-memory map rather than driven through
 * `fake-indexeddb`, whose structured clone drops `Blob` identity (the same
 * caveat recorded in `checkpoint-storage.test.ts`) — `readFileAsText` cannot
 * survive the round-trip there, and IndexedDB is not what these tests are about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      readFileAsText: async (name: string) => files.get(name) ?? null,
      exists: async (name: string) => files.has(name),
      deleteFile: async (name: string) => void files.delete(name),
      getMetadata: async (name: string) =>
        files.has(name)
          ? { name, mimeType: actual.inferMimeType(name), size: files.get(name)!.length, createdAt: 1, updatedAt: 1 }
          : undefined,
      writeFile: async (name: string, content: string) => {
        files.set(name, content);
        return {
          name,
          mimeType: actual.inferMimeType(name),
          size: content.length,
          createdAt: 1,
          updatedAt: 2,
        };
      },
    },
  };
});

const { FileMcpServer } = await import('@/lib/mcp/file-server');
const server = new FileMcpServer();

function toolFn(name: string) {
  const tool = server.getAITools()[name] as {
    execute: (args: unknown, context?: unknown) => Promise<Record<string, unknown>>;
  };
  if (!tool) throw new Error(`No such tool: ${name}`);
  return (args: Record<string, unknown>) => tool.execute(args, {});
}

const fileRead = toolFn('file_read');
const fileEdit = toolFn('file_edit');
const filePatch = toolFn('file_patch');

const lines = (...l: string[]) => l.join('\n');
const SOURCE = lines('header', 'import a', 'import b', '', 'function foo() {', '  return 1;', '}');
const stored = () => files.get('demo.ts');

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://test${p}` } });
  files.clear();
  files.set('demo.ts', SOURCE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('file_edit', () => {
  it('applies an anchored replacement', async () => {
    const result = await fileEdit({
      name: 'demo.ts',
      edits: [{ oldText: '  return 1;', newText: '  return 2;' }],
    });
    expect(result).toMatchObject({ success: true, editsApplied: 1 });
    expect(stored()).toBe(SOURCE.replace('return 1;', 'return 2;'));
  });

  it('applies several edits in one call', async () => {
    const result = await fileEdit({
      name: 'demo.ts',
      edits: [
        { oldText: 'import a', newText: 'import alpha' },
        { oldText: '  return 1;', newText: '  return 2;' },
      ],
    });
    expect(result).toMatchObject({ success: true, editsApplied: 2 });
    expect(stored()).toContain('import alpha');
    expect(stored()).toContain('return 2;');
  });

  it('leaves the file untouched when any edit in the batch fails', async () => {
    const result = await fileEdit({
      name: 'demo.ts',
      edits: [
        { oldText: 'import a', newText: 'import alpha' },
        { oldText: 'THIS TEXT IS NOT IN THE FILE', newText: 'x' },
      ],
    });
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(/edit\[1\]/);
    // The first edit must not have been persisted.
    expect(stored()).toBe(SOURCE);
  });

  it('refuses an ambiguous anchor rather than editing an arbitrary occurrence', async () => {
    files.set('demo.ts', lines('dup', 'mid', 'dup'));
    const result = await fileEdit({ name: 'demo.ts', edits: [{ oldText: 'dup', newText: 'X' }] });
    expect(result.error).toMatch(/ambiguous/i);
    expect(stored()).toBe(lines('dup', 'mid', 'dup'));
  });

  it('reports a missing file instead of creating one', async () => {
    const result = await fileEdit({ name: 'nope.ts', edits: [{ oldText: 'a', newText: 'b' }] });
    expect(result.error).toMatch(/not found/i);
    expect(files.has('nope.ts')).toBe(false);
  });

  it('deletes matched text when newText is empty', async () => {
    const result = await fileEdit({
      name: 'demo.ts',
      edits: [{ oldText: lines('import b', ''), newText: '' }],
    });
    expect(result).toMatchObject({ success: true });
    expect(stored()).not.toContain('import b');
  });

  it('notes when a match required whitespace normalization', async () => {
    files.set('demo.ts', lines('class A {', '    run() {', '        go();', '    }', '}'));
    const result = await fileEdit({
      name: 'demo.ts',
      // Anchor copied with the shared indent stripped, as models routinely do.
      edits: [
        { oldText: lines('run() {', '    go();', '}'), newText: lines('run() {', '    stop();', '}') },
      ],
    });
    expect(result).toMatchObject({ success: true });
    expect(result.note).toMatch(/normaliz/i);
    expect(stored()).toBe(lines('class A {', '    run() {', '        stop();', '    }', '}'));
  });

  it('returns a preview URL for a previewable file', async () => {
    const result = await fileEdit({
      name: 'demo.ts',
      edits: [{ oldText: '  return 1;', newText: '  return 2;' }],
    });
    expect(result.previewUrl).toBe('chrome-extension://test/preview.html?file=demo.ts');
  });
});

describe('file_patch', () => {
  it('applies a patch whose hunk line numbers are stale', async () => {
    // Regression: "-4" pointed at the wrong line, and the old applier deleted
    // `function foo() {` while leaving `return 1;` in place — silently.
    const patch = lines('@@ -4,3 +4,3 @@', ' function foo() {', '-  return 1;', '+  return 2;', ' }');
    const result = await filePatch({ name: 'demo.ts', patch });
    expect(result).toMatchObject({ success: true, hunksApplied: 1 });
    expect(stored()).toBe(SOURCE.replace('return 1;', 'return 2;'));
  });

  it('rejects a patch whose removal line is not in the file, leaving it untouched', async () => {
    const patch = lines('@@ -2,1 +2,1 @@', '-TOTALLY_WRONG_CONTENT', '+replacement');
    const result = await filePatch({ name: 'demo.ts', patch });
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(/hunk 1/);
    expect(stored()).toBe(SOURCE);
  });

  it('rejects a patch with no @@ header instead of reporting success on a no-op', async () => {
    const result = await filePatch({ name: 'demo.ts', patch: lines('-  return 1;', '+  return 2;') });
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(/@@/);
    expect(stored()).toBe(SOURCE);
  });

  it('accepts a numberless "@@ ... @@" header', async () => {
    const patch = lines('@@ ... @@', ' function foo() {', '-  return 1;', '+  return 2;', ' }');
    const result = await filePatch({ name: 'demo.ts', patch });
    expect(result).toMatchObject({ success: true });
    expect(stored()).toBe(SOURCE.replace('return 1;', 'return 2;'));
  });

  it('does not mistake Markdown bullets for diff syntax', async () => {
    files.set('demo.ts', lines('# Todo', '- item one', '- item two', '- item three'));
    const patch = lines('@@ ... @@', ' - item one', '-- item two', '+- ITEM TWO', ' - item three');
    const result = await filePatch({ name: 'demo.ts', patch });
    expect(result).toMatchObject({ success: true });
    expect(stored()).toBe(lines('# Todo', '- item one', '- ITEM TWO', '- item three'));
  });

  it('reports a missing file instead of creating one', async () => {
    const result = await filePatch({ name: 'nope.ts', patch: lines('@@ @@', '-a', '+b') });
    expect(result.error).toMatch(/not found/i);
    expect(files.has('nope.ts')).toBe(false);
  });
});

describe('file_read', () => {
  it('reports truncation so the model can page instead of assuming it read everything', async () => {
    files.set('demo.ts', 'x'.repeat(100));
    const result = await fileRead({ name: 'demo.ts', maxChars: 40 });
    expect(result.content).toBe('x'.repeat(40));
    expect(result.limit).toMatchObject({ totalChars: 100, returnedChars: 40, truncated: true });
  });

  it('pages with offset', async () => {
    files.set('demo.ts', 'abcdefghij');
    const result = await fileRead({ name: 'demo.ts', offset: 5 });
    expect(result.content).toBe('fghij');
    expect(result.limit).toMatchObject({ truncated: false });
  });

  it('reports a missing file', async () => {
    expect((await fileRead({ name: 'nope.ts' })).error).toMatch(/not found/i);
  });
});

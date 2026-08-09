/**
 * What a file dragged in from the operating system is allowed to become.
 *
 * The classification is the whole feature: it is what keeps binaries out of the
 * file manager, and it is the part that fails invisibly. Two traps in particular
 * are asserted here because they are not guessable from the code:
 *
 * - Chrome reports `.ts` as `video/mp2t` and `.vue` as an empty string, so a
 *   classifier that trusted `File.type` would refuse ordinary source files.
 * - `fileStorage.writeFile` is a keyed `put`, so an import that reused a name
 *   would silently replace an agent-generated file of the same name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Written {
  blob: Blob;
  options?: { conversationId?: string; mimeType?: string };
}

const stored = new Map<string, Written>();

/**
 * Only `exists` and `writeFile` are stubbed, and the two pure helpers come
 * through unchanged: the extension map and the preview categories under test are
 * the real ones, so this test fails if either of them stops covering a case.
 */
vi.mock('@/lib/mcp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcp/file-storage')>(
    '@/lib/mcp/file-storage',
  );
  return {
    inferMimeType: actual.inferMimeType,
    getPreviewCategory: actual.getPreviewCategory,
    fileStorage: {
      exists: async (name: string) => stored.has(name),
      writeFile: async (name: string, content: Blob, options?: Written['options']) => {
        stored.set(name, { blob: content, options });
        return { name };
      },
    },
  };
});

const { classifyDroppedFile, importTextFiles, resolveDroppedMimeType, uniqueFileName } =
  await import('@/lib/file-import');

/** A dropped file, with the MIME type the browser would have reported. */
function droppedFile(name: string, browserType: string, content = 'x'): File {
  return new File([content], name, { type: browserType });
}

beforeEach(() => {
  stored.clear();
});

describe('resolveDroppedMimeType', () => {
  it('prefers the extension map over the browser, which mistypes source files', () => {
    // The two cases that make `File.type` unusable as the primary source.
    expect(resolveDroppedMimeType(droppedFile('a.ts', 'video/mp2t'))).toBe('text/typescript');
    expect(resolveDroppedMimeType(droppedFile('App.vue', ''))).toBe('text/x-vue');
  });

  it('falls back to the browser for extensions the map does not know', () => {
    expect(resolveDroppedMimeType(droppedFile('server.log', 'text/plain'))).toBe('text/plain');
  });

  it('reports an unknown extension with no browser type as binary', () => {
    expect(resolveDroppedMimeType(droppedFile('data.bin', ''))).toBe('application/octet-stream');
  });
});

describe('classifyDroppedFile', () => {
  it('accepts text and code as storable', () => {
    expect(classifyDroppedFile(droppedFile('notes.md', 'text/markdown'))).toBe('text');
    expect(classifyDroppedFile(droppedFile('a.ts', 'video/mp2t'))).toBe('text');
    expect(classifyDroppedFile(droppedFile('data.json', 'application/json'))).toBe('text');
    expect(classifyDroppedFile(droppedFile('server.log', 'text/plain'))).toBe('text');
  });

  it('classifies images separately, since they are never stored', () => {
    expect(classifyDroppedFile(droppedFile('shot.png', 'image/png'))).toBe('image');
  });

  it('refuses every other binary', () => {
    expect(classifyDroppedFile(droppedFile('paper.pdf', 'application/pdf'))).toBe('unsupported');
    expect(classifyDroppedFile(droppedFile('bundle.zip', 'application/zip'))).toBe('unsupported');
    expect(classifyDroppedFile(droppedFile('setup.exe', ''))).toBe('unsupported');
  });
});

describe('uniqueFileName', () => {
  it('leaves a free name alone', async () => {
    expect(await uniqueFileName('report.md')).toBe('report.md');
  });

  it('keeps the folder prefix and the extension when stepping aside', async () => {
    stored.set('notes/report.md', { blob: new Blob() });
    expect(await uniqueFileName('notes/report.md')).toBe('notes/report (1).md');
  });

  it('keeps counting past the first taken suffix', async () => {
    stored.set('report.md', { blob: new Blob() });
    stored.set('report (1).md', { blob: new Blob() });
    expect(await uniqueFileName('report.md')).toBe('report (2).md');
  });

  it('treats a leading dot as the name, not an extension', async () => {
    stored.set('.gitignore', { blob: new Blob() });
    expect(await uniqueFileName('.gitignore')).toBe('.gitignore (1)');
  });
});

describe('importTextFiles', () => {
  it('stores text files and reports the names it wrote', async () => {
    const written = await importTextFiles([droppedFile('notes.md', 'text/markdown', 'hello')], {
      conversationId: 'c1',
    });

    expect(written).toEqual(['notes.md']);
    expect(stored.get('notes.md')?.options).toEqual({
      mimeType: 'text/markdown',
      conversationId: 'c1',
    });
  });

  it('omits the conversation when there is none, so the row reads as manual', async () => {
    await importTextFiles([droppedFile('notes.md', 'text/markdown')]);
    expect(stored.get('notes.md')?.options?.conversationId).toBeUndefined();
  });

  it('stores neither images nor other binaries', async () => {
    const written = await importTextFiles([
      droppedFile('shot.png', 'image/png'),
      droppedFile('bundle.zip', 'application/zip'),
    ]);

    expect(written).toEqual([]);
    expect(stored.size).toBe(0);
  });

  it('picks the text out of a mixed drop', async () => {
    const written = await importTextFiles([
      droppedFile('shot.png', 'image/png'),
      droppedFile('notes.md', 'text/markdown'),
    ]);

    expect(written).toEqual(['notes.md']);
  });

  it('never overwrites an existing file', async () => {
    stored.set('report.md', { blob: new Blob(['generated']) });

    const written = await importTextFiles([droppedFile('report.md', 'text/markdown', 'dropped')]);

    expect(written).toEqual(['report (1).md']);
    expect(await stored.get('report.md')!.blob.text()).toBe('generated');
    expect(await stored.get('report (1).md')!.blob.text()).toBe('dropped');
  });

  it('renames within a single drop, not just against storage', async () => {
    // Two files of the same name in one drop: the second must not land on the
    // free name the first was already given.
    const written = await importTextFiles([
      droppedFile('notes.md', 'text/markdown', 'first'),
      droppedFile('notes.md', 'text/markdown', 'second'),
    ]);

    expect(written).toEqual(['notes.md', 'notes (1).md']);
  });

  it('stores the blob under the resolved type, not the browser mistype', async () => {
    await importTextFiles([droppedFile('main.ts', 'video/mp2t')]);
    expect(stored.get('main.ts')?.blob.type).toBe('text/typescript');
  });
});

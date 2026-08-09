/**
 * File storage change notifications.
 *
 * Every view of the stored files — the preview tab, the options file manager, the
 * side panel's conversation list — used to be either load-once or driven by a
 * 3-second poll, because IndexedDB emits no change event. The fix depends on one
 * invariant: a write or delete through `fileStorage` always announces itself.
 *
 * The announcement lives in the storage layer rather than in the MCP tools
 * precisely so this test can be about *all* writers. `file_write`, `file_edit`
 * and `file_patch` are three of them; the options page deletes files too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onEvent, resetEventBusForTests, type LumoEventMap } from '@/lib/event-bus';

const files = new Map<string, string>();

/**
 * The IndexedDB layer is stubbed at the `openDB` boundary rather than run through
 * `fake-indexeddb`, whose structured clone drops Blob identity — the caveat
 * `checkpoint-storage.test.ts` records. What matters here is that the request's
 * success path emits, not that IndexedDB works.
 */
function fakeRequest<T>(result: T) {
  const request: Record<string, unknown> = { result, onsuccess: null, onerror: null };
  // Fire on the next microtask, as IndexedDB does.
  void Promise.resolve().then(() => {
    (request.onsuccess as (() => void) | null)?.();
  });
  return request;
}

vi.stubGlobal('indexedDB', {
  open: () => {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({
        objectStore: () => ({
          put: (value: { name: string; content: { size: number } }) => {
            files.set(value.name, 'stored');
            return fakeRequest(undefined);
          },
          delete: (name: string) => {
            files.delete(name);
            return fakeRequest(undefined);
          },
          get: (name: string) =>
            fakeRequest(files.has(name) ? { name, content: new Blob(['x']) } : undefined),
          count: (name: string) => fakeRequest(files.has(name) ? 1 : 0),
          getAllKeys: () => fakeRequest([...files.keys()]),
          clear: () => {
            files.clear();
            return fakeRequest(undefined);
          },
        }),
      }),
    };
    return fakeRequest(db);
  },
});

const { fileStorage } = await import('@/lib/mcp/file-storage');

let events: LumoEventMap['files:changed'][] = [];
let off: (() => void) | null = null;

beforeEach(() => {
  files.clear();
  events = [];
  off = onEvent('files:changed', (payload) => events.push(payload));
});

afterEach(() => {
  off?.();
  resetEventBusForTests();
});

describe('fileStorage change notifications', () => {
  it('announces a newly written file', async () => {
    await fileStorage.writeFile('notes.md', '# hello');
    expect(events).toEqual([{ names: ['notes.md'], reason: 'write' }]);
  });

  it('announces an overwrite, since a preview of that file is now stale', async () => {
    await fileStorage.writeFile('notes.md', 'v1');
    await fileStorage.writeFile('notes.md', 'v2');
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ names: ['notes.md'], reason: 'write' });
  });

  it('announces a delete', async () => {
    await fileStorage.writeFile('notes.md', 'x');
    events = [];
    await fileStorage.deleteFile('notes.md');
    expect(events).toEqual([{ names: ['notes.md'], reason: 'delete' }]);
  });

  it('names the file so a single-file view can ignore unrelated writes', async () => {
    await fileStorage.writeFile('other.md', 'x');
    // This is what lets the preview tab for notes.md skip the reload entirely.
    expect(events[0]!.names).toEqual(['other.md']);
  });

  it('announces every file in a batch of writes', async () => {
    await fileStorage.writeFile('a.md', 'x');
    await fileStorage.writeFile('b.md', 'y');
    expect(events.flatMap((e) => e.names)).toEqual(['a.md', 'b.md']);
  });

  it('does not announce a read', async () => {
    await fileStorage.writeFile('notes.md', 'x');
    events = [];
    await fileStorage.readFileAsText('notes.md');
    await fileStorage.exists('notes.md');
    expect(events).toEqual([]);
  });

  it('names every file a bulk clear removed', async () => {
    await fileStorage.writeFile('a.md', 'x');
    await fileStorage.writeFile('b.md', 'y');
    events = [];

    const removed = await fileStorage.clearFiles();

    expect(removed).toBe(2);
    // One event listing everything, not one per file: a single-file view still
    // has to find its own name in the list to know it is now stale.
    expect(events).toEqual([{ names: ['a.md', 'b.md'], reason: 'delete' }]);
  });

  it('says nothing when a clear removed nothing', async () => {
    expect(await fileStorage.clearFiles()).toBe(0);
    expect(events).toEqual([]);
  });
});

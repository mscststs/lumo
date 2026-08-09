/**
 * How much space Lumo's own data occupies, broken down by where it lives.
 *
 * Two IndexedDB databases, both unbounded, and both reclaimable from the about
 * page:
 *
 * - **`lumo-chat`** — conversations, their derived summaries and the offloaded
 *   screenshot blobs. This is the data that exhausted the 10 MB
 *   `chrome.storage.local` quota back when history lived there.
 * - **`lumo-files`** — files written by the file MCP server or dropped in by hand.
 *
 * Settings are deliberately not measured: they live in `chrome.storage.local`,
 * are bounded by design, and are never what fills a disk.
 *
 * Sizes are measured, not estimated from record counts: a conversation's cost is
 * dominated by inline user images, and a stored file's by its blob, so counts
 * alone would say nothing useful. `navigator.storage.estimate()` is reported
 * alongside as the browser's own view — it covers the whole origin (both
 * databases plus internal overhead) and so is always larger than the sum of the
 * parts below.
 *
 * Every area is collected independently and failures degrade to zero: one
 * unreadable database must not blank out the whole page.
 */

import {
  BLOBS_STORE,
  CONVERSATIONS_STORE,
  withStores,
} from '@/lib/chat-db';
import { fileStorage } from '@/lib/mcp/file-storage';

/** Records in one logical group, and the bytes they occupy. */
export interface StoreUsage {
  count: number;
  bytes: number;
}

export interface StorageUsageReport {
  /** `lumo-chat` conversation records, measured as serialised JSON. */
  conversations: StoreUsage;
  /**
   * `lumo-chat` blobs — tool-produced screenshots kept out of the JSON.
   *
   * Measured separately because they are a separate store with its own
   * lifecycle, even though the UI folds them into the chat-history total: they
   * are created and deleted with the conversation that produced them.
   */
  screenshots: StoreUsage;
  /** `lumo-files` stored files. */
  files: StoreUsage;
  /**
   * The browser's own accounting for this origin, when it exposes it.
   * `null` rather than zeroes when unavailable, so the UI can hide the row
   * instead of claiming nothing is stored.
   */
  origin: { usage: number; quota: number } | null;
}

const EMPTY_USAGE: StoreUsage = { count: 0, bytes: 0 };

/** UTF-8 byte length of a value's JSON form. */
function jsonBytes(value: unknown): number {
  return new Blob([JSON.stringify(value)]).size;
}

/**
 * Walk `store` with a cursor, accumulating count and bytes.
 *
 * A cursor rather than `getAll()`: conversation records carry inline images, so
 * the whole store can be tens of megabytes of JSON that there is no reason to
 * hold in memory at once just to add up its size.
 *
 * Hand-rolled rather than built on `request()` from `chat-db`: a cursor request
 * fires `onsuccess` once per record, and that helper resolves on the first one.
 */
function measureStore(
  store: IDBObjectStore,
  sizeOf: (record: unknown) => number,
): Promise<StoreUsage> {
  return new Promise((resolve, reject) => {
    const usage: StoreUsage = { count: 0, bytes: 0 };
    const cursorRequest = store.openCursor();

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve(usage);
        return;
      }
      usage.count += 1;
      usage.bytes += sizeOf(cursor.value);
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

/**
 * Measure both `lumo-chat` stores in one transaction.
 *
 * The `meta` store is skipped on purpose: it holds derived summaries whose size
 * is a rounding error next to the records they summarise, and reporting it as a
 * separate line would suggest there is something there to clean up.
 */
async function measureChatDB(): Promise<{
  conversations: StoreUsage;
  screenshots: StoreUsage;
}> {
  return withStores([CONVERSATIONS_STORE, BLOBS_STORE], 'readonly', async (tx) => {
    const conversations = await measureStore(tx.objectStore(CONVERSATIONS_STORE), jsonBytes);
    const screenshots = await measureStore(tx.objectStore(BLOBS_STORE), (record) => {
      const blob = (record as { blob?: Blob }).blob;
      return blob?.size ?? 0;
    });
    return { conversations, screenshots };
  });
}

/** Sum the stored files, reusing the metadata the file manager already reads. */
async function measureFiles(): Promise<StoreUsage> {
  const files = await fileStorage.listFiles();
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

async function measureOrigin(): Promise<{ usage: number; quota: number } | null> {
  const estimate = await navigator.storage?.estimate?.();
  if (!estimate || estimate.usage === undefined || estimate.quota === undefined) return null;
  return { usage: estimate.usage, quota: estimate.quota };
}

/** Resolve to `fallback` instead of rejecting, logging what went wrong. */
async function orFallback<T>(label: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error(`[storage-usage] failed to measure ${label}:`, error);
    return fallback;
  }
}

/** Collect the full report. Safe to call repeatedly; nothing is cached. */
export async function collectStorageUsage(): Promise<StorageUsageReport> {
  const [chat, files, origin] = await Promise.all([
    orFallback('chat history', measureChatDB, {
      conversations: EMPTY_USAGE,
      screenshots: EMPTY_USAGE,
    }),
    orFallback('stored files', measureFiles, EMPTY_USAGE),
    orFallback('origin estimate', measureOrigin, null),
  ]);

  return {
    conversations: chat.conversations,
    screenshots: chat.screenshots,
    files,
    origin,
  };
}

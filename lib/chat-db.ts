/**
 * IndexedDB layer for chat history (`lumo-chat`).
 *
 * Conversations used to live under a single `chrome.storage.local` key, which
 * has three fatal properties for unbounded user data:
 *
 * 1. **Quota.** Without the `unlimitedStorage` permission the whole `local`
 *    area is capped at 10 MB. A handful of persisted screenshots exhausted it
 *    and every subsequent write threw `Resource::kQuotaBytes quota exceeded`.
 * 2. **Write amplification.** `chrome.storage` serialises an entire key on
 *    every write, so saving one message re-serialised *all* history.
 * 3. **Read amplification.** Rendering the history list deserialised every
 *    message of every conversation just to show titles and timestamps.
 *
 * IndexedDB fixes all three: records are written and read individually, and the
 * quota is the browser's regular per-origin allowance rather than 10 MB. The
 * `storage` area keeps only bounded configuration plus a revision counter used
 * to broadcast changes (IndexedDB has no `onChanged` equivalent).
 *
 * Three stores, deliberately split:
 * - `conversations` — the full record, read only when a conversation is opened.
 * - `meta`          — lightweight summaries, so the history list never touches
 *                     message bodies.
 * - `blobs`         — tool-produced screenshots, kept out of the JSON record.
 */

const DB_NAME = 'lumo-chat';
const DB_VERSION = 1;

export const CONVERSATIONS_STORE = 'conversations';
export const META_STORE = 'meta';
export const BLOBS_STORE = 'blobs';

/** Index on `blobs` letting a conversation's screenshots be garbage collected. */
export const BLOB_CONVERSATION_INDEX = 'conversationId';
/** Index on `meta` so the history list can be read in recency order. */
export const META_UPDATED_AT_INDEX = 'updatedAt';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        const meta = db.createObjectStore(META_STORE, { keyPath: 'id' });
        meta.createIndex(META_UPDATED_AT_INDEX, 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        const blobs = db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
        blobs.createIndex(BLOB_CONVERSATION_INDEX, 'conversationId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Shared connection. Cached because every read goes through it, but dropped on
 * failure so a transient open error does not poison the whole session.
 */
export function getChatDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** Promisify a single request. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `body` inside one transaction over `stores` and resolve once the
 * transaction *commits*.
 *
 * Awaiting `oncomplete` rather than the last request matters: a write is only
 * durable after the commit, so resolving earlier would let callers broadcast a
 * change that a concurrent reader cannot see yet.
 */
export async function withStores<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await getChatDB();
  const tx = db.transaction(stores, mode);

  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Chat DB transaction aborted'));
  });

  // Read-only transactions have nothing to commit that the caller must wait
  // for, but errors still surface through `committed`.
  const result = await body(tx);
  await committed;
  return result;
}

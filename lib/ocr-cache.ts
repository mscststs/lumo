/**
 * OCR result cache backed by IndexedDB.
 *
 * Each image is identified by a SHA-256 hash of its base64 data, so duplicate
 * images across conversations are only processed once. A `configHash` invalidates
 * entries when the OCR settings (provider, model, prompt) change.
 */

import { sha256Hex } from '@/lib/hash';

const DB_NAME = 'lumo-ocr-cache';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

export interface OcrCacheEntry {
  /** SHA-256 hex digest of the image base64 data */
  id: string;
  /** OCR-generated text description */
  text: string;
  /** Hash of the OCR config that produced this result */
  configHash: string;
  /** Timestamp */
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** Derive the image key from its base64 content. */
export async function imageHash(base64Data: string): Promise<string> {
  return sha256Hex(base64Data);
}

/** Derive a config fingerprint so cache invalidates on settings change. */
export async function ocrConfigHash(providerId: string, modelId: string, prompt: string): Promise<string> {
  return sha256Hex(`${providerId}\0${modelId}\0${prompt}`);
}

/** Look up a cached OCR result. Returns `null` on miss or config mismatch. */
export async function getOcrCache(id: string, configHash: string): Promise<string | null> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const entry = await new Promise<OcrCacheEntry | undefined>((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result as OcrCacheEntry | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry || entry.configHash !== configHash) return null;
    return entry.text;
  } catch {
    return null;
  }
}

/** Write an OCR result to the cache. */
export async function setOcrCache(id: string, text: string, configHash: string): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: OcrCacheEntry = { id, text, configHash, createdAt: Date.now() };
    store.put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache write failure is non-fatal.
  }
}

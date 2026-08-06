/**
 * Sentinel URL scheme for images whose bytes live outside the conversation
 * record.
 *
 * Kept in its own module, free of any IndexedDB dependency, so the render path
 * (`lib/tool-output.ts`) can recognise a reference without importing the storage
 * layer — and so tests can exercise it without a database.
 *
 * A distinct scheme rather than a bare id makes a reference that escapes
 * resolution obvious in logs, instead of silently rendering as a broken image.
 */

export const BLOB_URL_SCHEME = 'lumo-blob:';

/** Build the sentinel URL the UI resolves through `resolveBlobUrl`. */
export function blobRef(id: string): string {
  return `${BLOB_URL_SCHEME}${id}`;
}

/** Read the blob id out of a sentinel URL, or `undefined` if it is not one. */
export function parseBlobRef(url: string): string | undefined {
  return url.startsWith(BLOB_URL_SCHEME) ? url.slice(BLOB_URL_SCHEME.length) : undefined;
}

/**
 * Digest helpers shared by features that need a stable, non-reversible
 * identifier for a piece of local data (OCR cache keys, provider session ids).
 *
 * WebCrypto is available in every context the extension runs in — side panel,
 * options page and the background service worker — so no fallback is needed.
 */

/** SHA-256 of `data`, lowercase hex. */
export async function sha256Hex(data: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

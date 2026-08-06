/**
 * Round-trip behaviour of blob-backed tool screenshots.
 *
 * The regression these guard against is subtle: `getConversation` marks stored
 * images with a `lumo-blob:` reference so the UI can resolve them lazily, and
 * continuing that conversation re-persists those very messages. If the save path
 * mistakes a marker for base64 it tries to decode it as image bytes, which
 * throws on every turn after the first.
 */

import { describe, it, expect } from 'vitest';
import { blobRef, parseBlobRef, BLOB_URL_SCHEME } from '@/lib/blob-ref';
import { normalizeToolOutput } from '@/lib/tool-output';

const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('blob references', () => {
  it('round-trips an id through the sentinel scheme', () => {
    const ref = blobRef('conv-1:0:1700000000');
    expect(ref.startsWith(BLOB_URL_SCHEME)).toBe(true);
    expect(parseBlobRef(ref)).toBe('conv-1:0:1700000000');
  });

  it('does not claim base64 payloads or data URLs', () => {
    expect(parseBlobRef(RED_PNG_DATA)).toBeUndefined();
    expect(parseBlobRef(`data:image/png;base64,${RED_PNG_DATA}`)).toBeUndefined();
  });

  it('is not decodable as base64', () => {
    // The reason the marker must be detected *before* any decode attempt: the
    // save path used to call `atob` on it, which throws.
    expect(() => atob(blobRef('conv-1:0:1'))).toThrow();
  });
});

describe('normalizeToolOutput with offloaded screenshots', () => {
  it('reports a stored screenshot as a reference, not a broken data URL', () => {
    const ref = blobRef('conv-1:0:1700000000');
    const normalized = normalizeToolOutput({
      content: [
        { type: 'image', data: ref, mimeType: 'image/png' },
        { type: 'text', text: 'Screenshot captured (png)' },
      ],
      isError: false,
    });

    expect(normalized.kind).toBe('image-ref');
    if (normalized.kind === 'image-ref') {
      expect(normalized.ref).toBe(ref);
      expect(normalized.caption).toBe('Screenshot captured (png)');
    }
  });

  it('still inlines a freshly captured screenshot', () => {
    // A screenshot that has not been through storage yet carries real base64 and
    // must render directly, without a database round trip.
    const normalized = normalizeToolOutput({
      content: [{ type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' }],
      isError: false,
    });

    expect(normalized.kind).toBe('image');
    if (normalized.kind === 'image') {
      expect(normalized.url).toBe(`data:image/png;base64,${RED_PNG_DATA}`);
    }
  });
});

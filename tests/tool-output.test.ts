import { describe, it, expect } from 'vitest';
import { normalizeToolOutput } from '@/lib/tool-output';

const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('normalizeToolOutput (UI display path)', () => {
  it('renders CallToolResult image parts as an image with caption', () => {
    const normalized = normalizeToolOutput({
      content: [
        { type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' },
        { type: 'text', text: 'Screenshot captured (png)' },
      ],
      isError: false,
    });

    expect(normalized.kind).toBe('image');
    if (normalized.kind === 'image') {
      expect(normalized.url).toBe(`data:image/png;base64,${RED_PNG_DATA}`);
      expect(normalized.caption).toBe('Screenshot captured (png)');
    }
  });

  it('passes long text through without truncating it', () => {
    // The UI used to cap text at 2000 chars, which silently cut the `limit`
    // metadata that page tools serialise *after* their long payload — the user
    // could no longer tell whether a read had been paged. Height is capped by
    // the scroll container instead, so the text must arrive intact.
    const hugeJson = JSON.stringify({ dataUrl: `data:image/png;base64,${'A'.repeat(5000)}` });
    const normalized = normalizeToolOutput({
      content: [{ type: 'text', text: hugeJson }],
      isError: false,
    });

    expect(normalized.kind).toBe('text');
    if (normalized.kind === 'text') {
      expect(normalized.text).toContain('A'.repeat(5000));
    }
  });

  it('surfaces isError results as errors', () => {
    const normalized = normalizeToolOutput({
      content: [{ type: 'text', text: 'File not found' }],
      isError: true,
    });
    expect(normalized.kind).toBe('error');
  });
});

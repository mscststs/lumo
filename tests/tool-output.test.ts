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

  it('still truncates legacy text-only dumps', () => {
    const hugeJson = JSON.stringify({ dataUrl: `data:image/png;base64,${'A'.repeat(5000)}` });
    const normalized = normalizeToolOutput({
      content: [{ type: 'text', text: hugeJson }],
      isError: false,
    });

    expect(normalized.kind).toBe('text');
    if (normalized.kind === 'text') {
      expect(normalized.truncated).toBe(true);
      expect(normalized.text.length).toBeLessThanOrEqual(2000);
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

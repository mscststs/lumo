import { describe, it, expect } from 'vitest';
import {
  IMAGE_CHARS,
  compactifyImageData,
  estimateCharsToTokens,
  measureModelMessagesChars,
  measureToolOutputChars,
  measureUIPartsChars,
} from '@/lib/prompt-size';
import type { ChatMessagePart } from '@/types';

/**
 * Context accounting is only as trustworthy as its price list. These tests pin
 * the invariant that made the composer ring report a 1M window as full while
 * the real prompt was a few thousand tokens: image bytes are never measured as
 * text, and an image only costs budget when the prompt actually carries it.
 */

const BIG_BASE64 = 'A'.repeat(1_500_000);
const CAPTION = 'Full-page screenshot captured (png, 1280x4000)';

function screenshotPart(data = BIG_BASE64): ChatMessagePart {
  return {
    type: 'tool-page_screenshot',
    toolCallId: 'tc1',
    state: 'output-available',
    input: { scope: 'fullpage' },
    output: {
      content: [
        { type: 'image', data, mimeType: 'image/png' },
        { type: 'text', text: CAPTION },
      ],
      isError: false,
    },
  } as unknown as ChatMessagePart;
}

function tokens(part: ChatMessagePart, mode: 'live' | 'replayed'): number {
  return estimateCharsToTokens(measureUIPartsChars([part], mode));
}

describe('compactifyImageData', () => {
  it('replaces a base64 data URL with a short marker', () => {
    expect(compactifyImageData(`before data:image/png;base64,${BIG_BASE64} after`)).toBe(
      'before [image] after',
    );
  });

  it('leaves text without image data untouched', () => {
    expect(compactifyImageData('plain text')).toBe('plain text');
  });
});

describe('image accounting', () => {
  it('charges a live screenshot a bounded constant, not its base64 length', () => {
    // 1.5MB of base64 used to read as ~375K tokens. The result still includes
    // the tool name, its arguments and the caption; only the image is bounded.
    const measured = tokens(screenshotPart(), 'live');
    expect(measured).toBeGreaterThan(IMAGE_CHARS / 4);
    expect(measured).toBeLessThan(IMAGE_CHARS / 4 + 100);
  });

  it('charges a replayed screenshot nothing for the image itself', () => {
    const replayed = tokens(screenshotPart(), 'replayed');
    const live = tokens(screenshotPart(), 'live');
    expect(replayed).toBeLessThan(50);
    expect(live - replayed).toBe(Math.ceil(IMAGE_CHARS / 4));
  });

  it('does not let the payload size change the estimate', () => {
    expect(tokens(screenshotPart('A'.repeat(10)), 'live')).toBe(
      tokens(screenshotPart(BIG_BASE64), 'live'),
    );
  });
});

describe('measureToolOutputChars', () => {
  it('understands the CallToolResult shape', () => {
    expect(
      measureToolOutputChars(
        { content: [{ type: 'text', text: 'hello' }], isError: false },
        'live',
      ),
    ).toBe('hello'.length);
  });

  it('understands the AI SDK content wrapper', () => {
    const output = {
      type: 'content',
      value: [
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: BIG_BASE64 } },
        { type: 'text', text: CAPTION },
      ],
    };
    expect(measureToolOutputChars(output, 'live')).toBe(IMAGE_CHARS + CAPTION.length);
    expect(measureToolOutputChars(output, 'replayed')).toBe(CAPTION.length);
  });

  it('understands the AI SDK json wrapper', () => {
    const output = {
      type: 'json',
      value: {
        content: [
          { type: 'image', data: BIG_BASE64, mimeType: 'image/png' },
          { type: 'text', text: CAPTION },
        ],
      },
    };
    const live = measureToolOutputChars(output, 'live');
    expect(live).toBeGreaterThanOrEqual(IMAGE_CHARS);
    expect(live).toBeLessThan(IMAGE_CHARS + 200);
    expect(measureToolOutputChars(output, 'replayed')).toBeLessThan(200);
  });

  it('bounds a bare image data URL', () => {
    expect(measureToolOutputChars(`data:image/png;base64,${BIG_BASE64}`, 'live')).toBe(
      IMAGE_CHARS,
    );
    expect(measureToolOutputChars(`data:image/png;base64,${BIG_BASE64}`, 'replayed')).toBe(0);
  });
});

describe('measureModelMessagesChars', () => {
  it('charges an injected image file part the constant', () => {
    const chars = measureModelMessagesChars([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'use this' },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: BIG_BASE64 },
          },
        ],
      } as never,
    ]);
    expect(chars).toBe('use this'.length + IMAGE_CHARS);
  });

  it('charges a wire tool result as text even if base64 hides in it', () => {
    const chars = measureModelMessagesChars([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'shot',
            toolCallId: 'tc1',
            output: {
              type: 'text',
              value: `data:image/png;base64,${BIG_BASE64}`,
            },
          },
        ],
      } as never,
    ]);
    expect(chars).toBeLessThan(100);
  });
});

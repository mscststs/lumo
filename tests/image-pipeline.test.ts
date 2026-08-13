import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import type { ChatMessagePart } from '@/types';
import {
  toolResultOutputHasImage,
  sanitizeToolOutput,
  sanitizeToolResultImages,
  extractImagesFromParts,
  buildImageUserMessage,
} from '@/lib/ai';

const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${RED_PNG_DATA}`;

/** A `content`-type tool output with one image file part + a caption. */
function contentOutputWithImage() {
  return {
    type: 'content' as const,
    value: [
      { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: RED_PNG_DATA } },
      { type: 'text' as const, text: 'Screenshot captured (png)' },
    ],
  };
}

/** A `json`-type tool output embedding the base64 inside a text part (legacy). */
function legacyJsonOutputWithImage() {
  return {
    type: 'json' as const,
    value: {
      content: [{ type: 'text', text: JSON.stringify({ success: true, dataUrl: DATA_URL, format: 'png' }) }],
      isError: false,
    },
  };
}

describe('toolResultOutputHasImage', () => {
  it('detects image file parts in content outputs', () => {
    expect(toolResultOutputHasImage(contentOutputWithImage())).toBe(true);
  });

  it('detects embedded data URLs in legacy json/text outputs', () => {
    expect(toolResultOutputHasImage(legacyJsonOutputWithImage())).toBe(true);
    expect(toolResultOutputHasImage({ type: 'text', value: DATA_URL })).toBe(true);
  });

  it('returns false for plain text/json outputs', () => {
    expect(toolResultOutputHasImage({ type: 'content', value: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(toolResultOutputHasImage({ type: 'json', value: { ok: true } })).toBe(false);
    expect(toolResultOutputHasImage({ type: 'text', value: 'no image here' })).toBe(false);
  });
});

describe('sanitizeToolOutput', () => {
  it('drops image file parts but keeps the text caption', () => {
    expect(sanitizeToolOutput(contentOutputWithImage())).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'Screenshot captured (png)' }],
    });
  });

  it('compactifies base64 blobs inside legacy json text', () => {
    const sanitized = sanitizeToolOutput(legacyJsonOutputWithImage());
    expect(sanitized).toMatchObject({ type: 'json' });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(RED_PNG_DATA);
    expect(serialized).toContain('[image]');
  });

  it('leaves non-image outputs untouched (same reference)', () => {
    const output = { type: 'json' as const, value: { ok: true } };
    expect(sanitizeToolOutput(output)).toBe(output);
  });
});

describe('sanitizeToolResultImages', () => {
  it('strips images from tool messages and leaves other roles intact', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'page_screenshot',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'page_screenshot',
            output: contentOutputWithImage(),
          },
        ],
      },
    ];

    const sanitized = sanitizeToolResultImages(messages);
    const toolMessage = sanitized.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    const result = (toolMessage as { content: Array<{ output?: unknown }> }).content[0];
    const output = result?.output as { type: string; value: unknown } | undefined;
    expect(output).toBeDefined();
    expect(output?.type).toBe('content');
    expect(JSON.stringify(output)).not.toContain(RED_PNG_DATA);
    expect(JSON.stringify(output)).toContain('Screenshot captured');
  });
});

describe('extractImagesFromParts', () => {
  // Case 1: Direct content array (legacy / unit test style)
  const directOutputPart = {
    type: 'tool-page_screenshot',
    toolCallId: 'call_1',
    state: 'output-available',
    input: {},
    output: {
      content: [
        { type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' },
        { type: 'text', text: 'Screenshot captured (png)' },
      ],
      isError: false,
    },
  } as unknown as ChatMessagePart;

  // Case 2: JSON-wrapped (SDK wraps when tool has no toModelOutput)
  const jsonWrappedPart = {
    type: 'tool-capture_screen',
    toolCallId: 'call_2',
    state: 'output-available',
    input: {},
    output: {
      type: 'json',
      value: {
        content: [
          { type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' },
          { type: 'text', text: 'Screenshot captured' },
        ],
        isError: false,
      },
    },
  } as unknown as ChatMessagePart;

  // Case 3: Content-wrapped (SDK wraps when tool has toModelOutput returning images)
  const contentWrappedPart = {
    type: 'tool-page_screenshot',
    toolCallId: 'call_3',
    state: 'output-available',
    input: {},
    output: {
      type: 'content',
      value: [
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: RED_PNG_DATA } },
        { type: 'text', text: 'Screenshot captured' },
      ],
    },
  } as unknown as ChatMessagePart;

  it('collects images from direct content array (case 1)', () => {
    const parts = [directOutputPart, { type: 'text', text: 'ignored', state: 'done' }] as ChatMessagePart[];
    expect(extractImagesFromParts(parts)).toEqual([{ data: RED_PNG_DATA, mimeType: 'image/png' }]);
  });

  it('collects images from JSON-wrapped output (case 2, no toModelOutput)', () => {
    const parts = [jsonWrappedPart] as ChatMessagePart[];
    expect(extractImagesFromParts(parts)).toEqual([{ data: RED_PNG_DATA, mimeType: 'image/png' }]);
  });

  it('collects images from content-wrapped output (case 3, with toModelOutput)', () => {
    const parts = [contentWrappedPart] as ChatMessagePart[];
    expect(extractImagesFromParts(parts)).toEqual([{ data: RED_PNG_DATA, mimeType: 'image/png' }]);
  });

  it('returns an empty array when no images are present', () => {
    const parts = [{ type: 'text', text: 'no tools', state: 'done' }] as ChatMessagePart[];
    expect(extractImagesFromParts(parts)).toEqual([]);
  });
});

describe('buildImageUserMessage', () => {
  it('builds a user message with file image parts and a label', () => {
    const message = buildImageUserMessage([{ data: RED_PNG_DATA, mimeType: 'image/png' }]);
    expect(message.role).toBe('user');
    expect(message.content).toHaveLength(2);
    const label = message.content[0];
    expect(label).not.toBeNull();
    if (typeof label === 'object' && 'type' in label) {
      expect(label.type).toBe('text');
      expect((label as { text: string }).text.length).toBeGreaterThan(0);
    }
    const file = message.content[1];
    expect(file).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: RED_PNG_DATA },
    });
  });
});

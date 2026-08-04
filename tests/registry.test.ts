import { describe, it, expect } from 'vitest';
import { normalizeToCallToolResult, mcpToModelOutput } from '@/lib/mcp/registry';

/** A 1x1 transparent PNG (valid but tiny), reused as the image fixture. */
const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${RED_PNG_DATA}`;

describe('normalizeToCallToolResult', () => {
  it('wraps plain text results', () => {
    expect(normalizeToCallToolResult('hello')).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
  });

  it('passes through existing CallToolResult values untouched', () => {
    const result = { content: [{ type: 'text', text: 'ok' }], isError: false };
    expect(normalizeToCallToolResult(result)).toBe(result);
  });

  it('marks error-shaped objects as errors', () => {
    expect(normalizeToCallToolResult({ error: 'boom' })).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });

  it('does not turn a data URL nested in an object into an image part', () => {
    // Results were once scanned recursively for `data:image/` strings. That
    // hijacked every tool which merely *reports* image URLs (`page_evaluate`
    // returning `img.src`) — the payload became an image part plus an
    // `[image NNKB]` placeholder, losing the data the caller asked for.
    // Images are opt-in now: emit a `content` array (see page_screenshot).
    const normalized = normalizeToCallToolResult({ success: true, dataUrl: DATA_URL, format: 'png' });
    expect(normalized.isError).toBe(false);
    expect(normalized.content).toEqual([
      { type: 'text', text: JSON.stringify({ success: true, dataUrl: DATA_URL, format: 'png' }) },
    ]);
    // `lib/ai.ts` still keeps the base64 out of the model prompt; see
    // tests/image-pipeline.test.ts.
    expect(normalized.content[0]!.text).toContain(RED_PNG_DATA);
  });

  it('treats a bare data URL string as a single image part', () => {
    expect(normalizeToCallToolResult(DATA_URL)).toEqual({
      content: [{ type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' }],
      isError: false,
    });
  });

  it('stringifies plain objects that carry no image', () => {
    expect(normalizeToCallToolResult({ a: 1, b: 'two' })).toEqual({
      content: [{ type: 'text', text: '{"a":1,"b":"two"}' }],
      isError: false,
    });
  });
});

describe('mcpToModelOutput', () => {
  it('converts image content into file content parts', () => {
    const output = mcpToModelOutput({
      toolCallId: 'call_1',
      input: {},
      output: {
        content: [
          { type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' },
          { type: 'text', text: 'Screenshot captured (png)' },
        ],
        isError: false,
      },
    });

    expect(output).toEqual({
      type: 'content',
      value: [
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: RED_PNG_DATA } },
        { type: 'text', text: 'Screenshot captured (png)' },
      ],
    });
  });

  it('keeps the legacy json shape for text-only results', () => {
    const result = { content: [{ type: 'text', text: 'hi' }], isError: false };
    expect(mcpToModelOutput({ toolCallId: 'call_1', input: {}, output: result })).toEqual({
      type: 'json',
      value: result,
    });
  });

  it('falls back to json for non-CallToolResult outputs', () => {
    expect(mcpToModelOutput({ toolCallId: 'call_1', input: {}, output: 'plain string' })).toEqual({
      type: 'json',
      value: 'plain string',
    });
  });
});

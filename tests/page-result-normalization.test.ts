/**
 * How page-tool results travel through normalisation to the UI.
 *
 * The tool layer, `registry.ts` and `tool-output.ts` each transform the result,
 * and the property the whole ref design rests on only holds if all three agree:
 * a stale ref has to reach the *model* as an error, not as a successful-looking
 * payload. That contract spans modules, so unit tests on either side miss it.
 */

import { describe, expect, it } from 'vitest';
import { normalizeToCallToolResult } from '@/lib/mcp/registry';
import { normalizeToolOutput } from '@/lib/tool-output';

const readResult = {
  url: 'https://example.com/a',
  title: 'Article',
  resolvedMode: 'article' as const,
  markdown: '# Heading\n\nBody text.',
  limit: { totalChars: 21, returnedChars: 21, offset: 0, truncated: false },
};

describe('page tool result normalisation', () => {
  it('passes a page_read result through as text', () => {
    const normalized = normalizeToCallToolResult(readResult);
    expect(normalized.isError).toBe(false);
    expect(normalized.content[0]).toMatchObject({ type: 'text' });
    expect(normalized.content[0]!.text).toContain('# Heading');
  });

  it('surfaces a stale ref as an error the model cannot mistake for success', () => {
    const normalized = normalizeToCallToolResult({
      error: 'Element ref "e9" is no longer on the page.',
    });
    // `registry.ts` flips `{ error }` to isError when the object has ≤2 keys;
    // adding fields to the failure shape would silently break this.
    expect(normalized.isError).toBe(true);
    expect(normalizeToolOutput(normalized)).toEqual({
      kind: 'error',
      message: 'Element ref "e9" is no longer on the page.',
    });
  });

  it('renders a truncated read as text, with the limit metadata intact', () => {
    const truncated = {
      ...readResult,
      limit: { totalChars: 84_210, returnedChars: 20_000, offset: 0, truncated: true },
    };
    const output = normalizeToolOutput(normalizeToCallToolResult(truncated));
    expect(output.kind).toBe('text');
    // The model reads `truncated` and `totalChars` off the payload to decide
    // whether to page; UI truncation must not remove them.
    expect(output.kind === 'text' && output.text).toContain('"truncated": true');
    expect(output.kind === 'text' && output.text).toContain('84210');
  });

  it('keeps a snapshot result out of the image path', () => {
    const normalized = normalizeToCallToolResult({
      url: 'u',
      title: 't',
      snapshot: '- button "Act" [ref=e1]',
      refCount: 1,
      limit: { totalChars: 23, returnedChars: 23, offset: 0, truncated: false },
    });
    // `collectImageParts` scans strings for `data:image/`; a snapshot must not
    // trip it and turn into an image part.
    expect(normalized.content.every((part) => part.type === 'text')).toBe(true);
  });

  it('reports an empty find result as a normal, non-error payload', () => {
    const normalized = normalizeToCallToolResult({
      url: 'u',
      title: 't',
      matches: [],
      totalMatches: 0,
      limit: { totalChars: 0, returnedChars: 0, offset: 0, truncated: false },
    });
    // "Found nothing" is an answer, not a failure — flagging it would make the
    // model retry pointlessly.
    expect(normalized.isError).toBe(false);
  });
});

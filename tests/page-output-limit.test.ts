/**
 * Output limit contract.
 *
 * `page_get_text` / `page_get_html` had no ceiling at all: `MAX_TEXT_LENGTH` in
 * `lib/tool-output.ts` truncates the *UI* only, so the model still received the
 * whole page and a single call could exhaust the context window (spec §1.3 D).
 *
 * The property that matters most is not the truncation itself but that it is
 * *reported*. A silent `slice(0, 5000)` leaves the model believing it read the
 * whole page, which is unrecoverable; `truncated: true` plus `totalChars` lets it
 * page through.
 */

import { describe, expect, it } from 'vitest';
import { applyOutputLimit, DEFAULT_MAX_CHARS, HARD_MAX_CHARS } from '@/lib/page/output-limit';

const long = 'x'.repeat(50_000);

describe('applyOutputLimit', () => {
  it('returns the whole text when under the limit', () => {
    const result = applyOutputLimit('short text');
    expect(result.text).toBe('short text');
    expect(result.limit).toEqual({
      totalChars: 10,
      returnedChars: 10,
      offset: 0,
      truncated: false,
    });
  });

  it('applies the default ceiling when none is given', () => {
    const result = applyOutputLimit(long);
    expect(result.text).toHaveLength(DEFAULT_MAX_CHARS);
    expect(result.limit.truncated).toBe(true);
    // Reporting the real total is what makes truncation recoverable.
    expect(result.limit.totalChars).toBe(50_000);
  });

  it('truncates at maxChars and reports totalChars', () => {
    const result = applyOutputLimit(long, { maxChars: 100 });
    expect(result.text).toHaveLength(100);
    expect(result.limit).toEqual({
      totalChars: 50_000,
      returnedChars: 100,
      offset: 0,
      truncated: true,
    });
  });

  it('supports paging via offset', () => {
    const text = 'abcdefghij';
    const first = applyOutputLimit(text, { maxChars: 4 });
    const second = applyOutputLimit(text, { maxChars: 4, offset: 4 });
    const third = applyOutputLimit(text, { maxChars: 4, offset: 8 });

    expect(first.text + second.text + third.text).toBe(text);
    expect(first.limit.truncated).toBe(true);
    expect(second.limit.truncated).toBe(true);
    expect(third.limit.truncated).toBe(false);
  });

  it('clamps maxChars to HARD_MAX_CHARS', () => {
    const huge = 'y'.repeat(HARD_MAX_CHARS + 5_000);
    const result = applyOutputLimit(huge, { maxChars: 10_000_000 });
    expect(result.text).toHaveLength(HARD_MAX_CHARS);
    expect(result.limit.truncated).toBe(true);
  });

  it('clamps a negative offset to 0', () => {
    const result = applyOutputLimit('abcdef', { offset: -10 });
    expect(result.text).toBe('abcdef');
    expect(result.limit.offset).toBe(0);
  });

  it('clamps a zero or negative maxChars to at least one character', () => {
    expect(applyOutputLimit('abcdef', { maxChars: 0 }).text).toBe('a');
    expect(applyOutputLimit('abcdef', { maxChars: -5 }).text).toBe('a');
  });

  it('reports truncated=false when offset+len reaches the end', () => {
    const result = applyOutputLimit('abcdef', { offset: 3, maxChars: 3 });
    expect(result.text).toBe('def');
    expect(result.limit.truncated).toBe(false);
  });

  it('returns an empty slice past the end without claiming truncation', () => {
    const result = applyOutputLimit('abcdef', { offset: 100 });
    expect(result.text).toBe('');
    expect(result.limit.returnedChars).toBe(0);
    // There is nothing further to fetch, so telling the model to page again
    // would send it into a loop.
    expect(result.limit.truncated).toBe(false);
  });

  it('handles an empty input', () => {
    const result = applyOutputLimit('');
    expect(result.text).toBe('');
    expect(result.limit.truncated).toBe(false);
  });

  it('ignores non-finite parameters instead of producing NaN slices', () => {
    const result = applyOutputLimit('abcdef', {
      maxChars: Number.NaN,
      offset: Number.NaN,
    });
    expect(result.text).toBe('abcdef');
    expect(result.limit.offset).toBe(0);
  });

  it('floors fractional parameters', () => {
    const result = applyOutputLimit('abcdef', { maxChars: 2.9, offset: 1.7 });
    expect(result.text).toBe('bc');
    expect(result.limit.offset).toBe(1);
  });
});

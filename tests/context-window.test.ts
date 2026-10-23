import { describe, it, expect } from 'vitest';
import {
  CONTEXT_WINDOW_PRESETS,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  formatContextTokens,
  isContextWindowPreset,
  normalizeContextWindow,
} from '@/lib/context-window';

/**
 * `undefined` is the one meaningful "not declared" value: it is what hides the
 * composer's context ring. The fragile part is everything that could slip a
 * non-usable number past that rule — an empty form string, a hand-edited export,
 * or a value below the minimum — because a bogus window would draw a percentage
 * against a denominator the user never chose.
 */

describe('CONTEXT_WINDOW_PRESETS', () => {
  it('is ordered largest first and all count as presets', () => {
    for (let i = 1; i < CONTEXT_WINDOW_PRESETS.length; i++) {
      expect(CONTEXT_WINDOW_PRESETS[i]!).toBeLessThan(CONTEXT_WINDOW_PRESETS[i - 1]!);
    }
    for (const preset of CONTEXT_WINDOW_PRESETS) {
      expect(isContextWindowPreset(preset)).toBe(true);
    }
  });
});

describe('normalizeContextWindow', () => {
  it('reads "nothing" as not declared', () => {
    expect(normalizeContextWindow(undefined)).toBeUndefined();
    expect(normalizeContextWindow(null)).toBeUndefined();
    expect(normalizeContextWindow('')).toBeUndefined();
  });

  it('treats a non-numeric or too-small value as not declared', () => {
    expect(normalizeContextWindow('abc')).toBeUndefined();
    expect(normalizeContextWindow(NaN)).toBeUndefined();
    expect(normalizeContextWindow(-1)).toBeUndefined();
    expect(normalizeContextWindow(MIN_CONTEXT_WINDOW - 1)).toBeUndefined();
  });

  it('keeps a usable window, truncating fractions', () => {
    expect(normalizeContextWindow(128_000)).toBe(128_000);
    expect(normalizeContextWindow(MIN_CONTEXT_WINDOW)).toBe(MIN_CONTEXT_WINDOW);
    expect(normalizeContextWindow('64000')).toBe(64_000);
    expect(normalizeContextWindow(128_000.9)).toBe(128_000);
  });

  it('caps an absurd window at the upper bound', () => {
    expect(normalizeContextWindow(MAX_CONTEXT_WINDOW + 1)).toBe(MAX_CONTEXT_WINDOW);
    expect(normalizeContextWindow(Infinity)).toBeUndefined();
  });
});

describe('formatContextTokens', () => {
  it.each([
    [0, '0'],
    [512, '512'],
    [1_000, '1K'],
    [1_600, '1.6K'],
    [32_000, '32K'],
    [54_210, '54.2K'],
    [128_000, '128K'],
    [1_000_000, '1M'],
    [1_500_000, '1.5M'],
  ] as const)('formats %i as %s', (count, expected) => {
    expect(formatContextTokens(count)).toBe(expected);
  });

  it('never returns a negative or NaN label', () => {
    expect(formatContextTokens(-1)).toBe('0');
    expect(formatContextTokens(NaN)).toBe('0');
  });
});

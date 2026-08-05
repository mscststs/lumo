import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_THEME,
  SYSTEM_DARK_THEME,
  THEMES,
  THEME_OPTIONS,
  normalizeTheme,
} from '@/lib/theme-registry';

const CSS = readFileSync(resolve(__dirname, '../assets/globals.css'), 'utf8');

describe('theme registry', () => {
  it('offers every palette plus `system`, with `system` last', () => {
    const values = THEME_OPTIONS.map((o) => o.value);
    expect(values).toEqual([...Object.keys(THEMES), 'system']);
    expect(values.at(-1)).toBe('system');
  });

  it('resolves `system` to a palette that is actually registered', () => {
    expect(SYSTEM_DARK_THEME in THEMES).toBe(true);
  });

  describe('normalizeTheme', () => {
    it('passes through every registered theme and `system`', () => {
      for (const name of [...Object.keys(THEMES), 'system']) {
        expect(normalizeTheme(name)).toBe(name);
      }
    });

    it.each([
      ['a theme from a newer build', 'solarized'],
      ['a missing field', undefined],
      ['a non-string', 42],
    ])('falls back to the default for %s', (_label, input) => {
      expect(normalizeTheme(input)).toBe(DEFAULT_THEME);
    });
  });
});

describe('theme tokens in globals.css', () => {
  /**
   * `light` lives in the base `@theme` block as the unprefixed default, and
   * `dark` predates the registry so it keeps the bare `.dark` selector. Every
   * palette added on top must be reachable by the `data-theme` attribute that
   * `applyTheme` sets.
   */
  const attributeThemes = Object.keys(THEMES).filter((n) => n !== 'light' && n !== 'dark');

  it.each(attributeThemes)('declares a `data-theme` block for %s', (name) => {
    expect(CSS).toMatch(new RegExp(`\\[data-theme=['"]${name}['"]\\]`));
  });

  /**
   * A palette that omits a token silently inherits the light value, which on a
   * dark surface means invisible text. Comparing against the light `@theme`
   * block catches that at build time rather than by eye.
   */
  it('covers every base colour token in each dark palette', () => {
    const baseBlock = CSS.slice(CSS.indexOf('@theme {'));
    const baseTokens = [
      ...baseBlock.slice(0, baseBlock.indexOf('}')).matchAll(/(--color-[\w-]+):/g),
    ].map((m) => m[1]);
    expect(baseTokens.length).toBeGreaterThan(10);

    for (const [name, meta] of Object.entries(THEMES)) {
      if (!meta.dark) continue;
      // `dark` uses the bare `.dark` selector; extra palettes qualify it.
      const selector = name === 'dark' ? '.dark {' : `[data-theme='${name}'] {`;
      const start = CSS.indexOf(selector);
      expect(start, `no token block for ${name}`).toBeGreaterThan(-1);
      const block = CSS.slice(start, CSS.indexOf('}', start));
      const missing = baseTokens.filter((tok) => !block.includes(`${tok}:`));
      expect(missing, `${name} is missing tokens`).toEqual([]);
    }
  });

  it('paints the midnight surface at #22242a', () => {
    const start = CSS.indexOf("[data-theme='midnight'] {");
    const block = CSS.slice(start, CSS.indexOf('}', start));
    // hsl(225 10.5% 14.9%) is #22242a; assert the source form so a hand edit to
    // the lightness has to be deliberate.
    expect(block).toContain('--color-background: hsl(225 10.5% 14.9%)');
  });
});

/**
 * The modal scrim.
 *
 * This existed as `bg-foreground/40`, which read as "tracks the theme" but
 * inverted: `--color-foreground` is near-white on both dark palettes, so the
 * overlay bleached the page instead of dimming it. The invariant is that a
 * scrim is *always* dark, in every palette — separation between modal and
 * backdrop comes from the dialog's own elevation, not from flipping the scrim.
 */
describe('modal overlay token', () => {
  /** Lightness (%) and alpha of `--color-overlay` in a token block. */
  function overlay(selector: string) {
    const start = selector === ':root' ? CSS.indexOf('@theme {') : CSS.indexOf(selector);
    expect(start, `no token block for ${selector}`).toBeGreaterThan(-1);
    const block = CSS.slice(start, CSS.indexOf('}', start));
    const match = block.match(/--color-overlay:\s*hsl\([^)]*?([\d.]+)%\s*\/\s*([\d.]+)\)/);
    expect(match, `${selector} has no parseable --color-overlay`).not.toBeNull();
    return { lightness: Number(match![1]), alpha: Number(match![2]) };
  }

  const selectors = [':root', '.dark {', "[data-theme='midnight'] {"];

  it.each(selectors)('keeps the scrim dark and translucent in %s', (selector) => {
    const { lightness, alpha } = overlay(selector);
    // A scrim brighter than mid-grey lightens the page — the original bug.
    expect(lightness, 'scrim must be a dark wash').toBeLessThan(20);
    // Fully opaque would hide the context the modal is acting on.
    expect(alpha).toBeGreaterThan(0.3);
    expect(alpha).toBeLessThan(0.85);
  });

  it('dims harder on the dark palettes than on light', () => {
    // The same alpha over an already-dark page reads as barely dimmed, so the
    // modal fails to detach from its backdrop.
    const light = overlay(':root').alpha;
    for (const selector of ['.dark {', "[data-theme='midnight'] {"]) {
      expect(overlay(selector).alpha, `${selector} should dim harder`).toBeGreaterThan(light);
    }
  });

  it('is not derived from a foreground or background tint', () => {
    // Guards the regression directly: an opacity modifier on a semantic colour
    // whose lightness flips between palettes cannot be a scrim.
    const dialog = readFileSync(resolve(__dirname, '../components/ui/dialog.tsx'), 'utf8');
    // Strip comments first — the file documents the old bug by name, and that
    // prose must not count as a usage.
    const code = dialog.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('bg-overlay');
    expect(code).not.toContain('bg-foreground/');
    expect(code).not.toContain('bg-black/');
  });
});

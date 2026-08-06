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
import { themePreloadPlugin } from '@/lib/build/theme-preload-plugin';

const CSS = readFileSync(resolve(__dirname, '../assets/globals.css'), 'utf8');
const PRELOAD = readFileSync(resolve(__dirname, '../public/theme-preload.js'), 'utf8');
const ENTRYPOINTS = ['sidepanel', 'options', 'preview'] as const;

/**
 * Parse the theme table out of `theme-preload.js`. Deliberately text-parsed:
 * the script is copied to the build verbatim from `public/`, so asserting on
 * its source is what actually protects the shipped artifact.
 */
function parseThemeTable(source: string): Record<string, { dark: boolean; background: string }> | null {
  const match = source.match(/var THEMES = \{([\s\S]*?)\n  \};/);
  if (!match) return null;
  const body = match[1] ?? '';
  const out: Record<string, { dark: boolean; background: string }> = {};
  for (const row of body.matchAll(/(\w+):\s*\{\s*dark:\s*(true|false),\s*background:\s*'([^']+)'\s*\}/g)) {
    const key = row[1];
    const dark = row[2];
    const bg = row[3];
    if (key && dark && bg) out[key] = { dark: dark === 'true', background: bg };
  }
  return out;
}

/** Convert an `hsl(222.2 84% 4.9%)` token value to the `#rrggbb` the inline
 *  paint must match. Colors are stored as HSL in CSS but as hex in the preload,
 *  so compare them in one canonical form. */
function hexFromHsl(hsl: string): string {
  const m = hsl.match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/);
  if (!m) return '';
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(hue(h + 1 / 3))}${toHex(hue(h))}${toHex(hue(h - 1 / 3))}`;
}

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

/**
 * First-paint theming (anti-FOUC).
 *
 * The regression: `<html>` carried no theme markup, so the browser painted the
 * light default, and the palette was only applied inside a React effect after
 * two awaited `chrome.storage` reads. On a dark theme every page open flashed
 * white — worst in the side panel, whose document is destroyed on close and so
 * re-flashed every single time.
 *
 * Defence is layered, because each layer covers a case the others cannot:
 *  1. `theme-preload.js` — synchronous, reads the `localStorage` mirror, and is
 *     the only layer that can honour an *explicit* dark choice under an OS set
 *     to light.
 *  2. CSS `html:not([data-theme])` — covers `system` when no script ran at all.
 *  3. `bootstrapPage` — paints the authoritative value before React mounts.
 */
describe('first-paint theming', () => {
  describe('preload script', () => {
    it('classifies every registered palette', () => {
      // The mirror is written by `applyTheme` for *any* palette, so a theme the
      // script does not recognise falls through to the media-query branch and
      // gets mispainted — the exact flash this is meant to remove. `public/` is
      // copied verbatim and cannot import the registry, so the table is pinned.
      const parsed = parseThemeTable(PRELOAD);
      expect(parsed, 'no THEMES table found').not.toBeNull();
      expect(Object.keys(parsed!).sort()).toEqual(Object.keys(THEMES).sort());
    });

    it('agrees with the registry on the palette `system` resolves to', () => {
      expect(PRELOAD).toContain(`var SYSTEM_DARK_THEME = '${SYSTEM_DARK_THEME}'`);
    });

    it('sets both channels `applyTheme` uses', () => {
      // A `data-theme` without `.dark` leaves Tailwind's `dark:` utilities and
      // the Shiki overrides on their light values against a dark surface.
      expect(PRELOAD).toContain("classList.add('dark')");
      expect(PRELOAD).toContain("setAttribute('data-theme'");
    });

    it('survives localStorage being unavailable', () => {
      // Throws outright under partitioned/policy-disabled storage. Unguarded,
      // the script aborts and paints nothing.
      expect(PRELOAD).toMatch(/try\s*{[^}]*localStorage\.getItem/);
    });

    it('writes the mirror it reads, keyed identically', () => {
      const theme = readFileSync(resolve(__dirname, '../lib/theme.ts'), 'utf8');
      const key = PRELOAD.match(/var STORAGE_KEY = '([^']+)'/);
      expect(key, 'STORAGE_KEY not found in preload').not.toBeNull();
      // Reader and writer must name the same key or the mirror is never hit.
      expect(theme).toContain(`MIRROR_KEY = '${key![1]}'`);
      expect(theme).toContain('localStorage.setItem(MIRROR_KEY');
    });

    it('paints inline so it works without a stylesheet', () => {
      // Dev builds have no CSS at first paint (globals.css is injected as a
      // runtime <style> from main.tsx), so setting classes alone is not enough —
      // the background has to be painted directly on the element.
      expect(PRELOAD).toMatch(/root\.style\.backgroundColor\s*=\s*theme\.background/);
      expect(PRELOAD).toMatch(/root\.style\.colorScheme\s*=\s*theme\.dark\s*\?\s*'dark'\s*:\s*'light'/);
      // Marked so `applyTheme` can hand control back to the stylesheet.
      expect(PRELOAD).toContain("setAttribute('data-theme-preload', '')");
    });
  });

  /**
   * The preload cannot import the registry, so its theme table is duplicated.
   * This keeps the duplicate honest: the palette set must match the registry,
   * and each inline colour must match the `--color-background` of the
   * corresponding token block. A theme added to the registry or retinted in CSS
   * fails here until the preload is updated, which is exactly the point.
   */
  describe('preload palette sync', () => {
    it('matches every registry palette', () => {
      const parsed = parseThemeTable(PRELOAD);
      expect(parsed).not.toBeNull();
      for (const [name, meta] of Object.entries(THEMES)) {
        expect(parsed, `no inline entry for ${name}`).toHaveProperty(name);
        const inline = parsed![name]!;
        expect(inline.dark, `${name} dark flag disagrees with registry`).toBe(meta.dark);
      }
    });

    it('matches the `--color-background` of every palette', () => {
      const parsed = parseThemeTable(PRELOAD);
      expect(parsed).not.toBeNull();

      const baseBlock = CSS.slice(CSS.indexOf('@theme {'));
      const base = baseBlock.slice(0, baseBlock.indexOf('}'));
      const light = base.match(/--color-background:\s*([^;]+);/)?.[1]?.trim();
      expect(light, 'no light background in @theme').toBeDefined();
      expect(parsed!.light!.background).toBe(hexFromHsl(light!));

      for (const name of Object.keys(parsed!)) {
        if (name === 'light') continue;
        // `dark` uses the bare `.dark` selector; extra palettes qualify it.
        const selector = name === 'dark' ? '.dark {' : `[data-theme='${name}'] {`;
        const start = CSS.indexOf(selector);
        expect(start, `no token block for ${name}`).toBeGreaterThan(-1);
        const block = CSS.slice(start, CSS.indexOf('}', start));
        const hsl = block.match(/--color-background:\s*([^;]+);/)?.[1]?.trim();
        expect(hsl, `${name} has no --color-background`).toBeDefined();
        const inline = parsed![name]!;
        expect(inline.background).toBe(hexFromHsl(hsl!));
      }
    });
  });

  describe('injection via theme-preload-plugin', () => {
    const plugin = themePreloadPlugin();

    it('is wired into the Vite config', () => {
      const config = readFileSync(resolve(__dirname, '../wxt.config.ts'), 'utf8');
      expect(config).toContain('themePreloadPlugin()');
      expect(config).toContain('import { themePreloadPlugin }');
    });

    it('is a transformIndexHtml plugin, not a runtime tag', () => {
      // A <script> baked into each index.html drifts; the plugin makes injection
      // a property of the build so a new entrypoint cannot ship without it.
      expect(typeof plugin.transformIndexHtml).toBe('object');
      const descriptor = plugin.transformIndexHtml as {
        order?: string;
        handler?: unknown;
      };
      expect(descriptor.order).toBe('pre');
      expect(typeof descriptor.handler).toBe('function');
    });

    it('prepends a synchronous script that loads theme-preload.js', () => {
      const descriptor = plugin.transformIndexHtml as {
        handler: (html: string) => unknown;
      };
      const tags = descriptor.handler('<!doctype html><html><head></head><body></body></html>') as Array<{
        tag?: string;
        injectTo?: string;
        attrs?: unknown;
      }>;
      expect(tags).toHaveLength(1);
      const tag = tags[0];
      expect(tag).toBeDefined();
      expect(tag).toMatchObject({ tag: 'script', injectTo: 'head-prepend' });
      // No `type="module"`/`defer`: a module script is implicitly deferred and
      // would run after first paint, silently restoring the flash.
      expect(tag!.attrs).toEqual({ src: '/theme-preload.js' });
    });

    it('is idempotent when the script is already present', () => {
      // WXT runs the HTML transform twice (written output + dev-server response)
      // and the same plugin takes part in both; the guard prevents a duplicate
      // tag in the built HTML.
      const descriptor = plugin.transformIndexHtml as {
        handler: (html: string) => unknown;
      };
      const already = descriptor.handler('<head><script src="/theme-preload.js"></script></head>');
      expect(already).toEqual([]);
    });

    it.each(ENTRYPOINTS)('leaves %s index.html free of a manual tag', (name) => {
      const html = readFileSync(resolve(__dirname, `../entrypoints/${name}/index.html`), 'utf8');
      expect(html, `${name} should rely on the plugin, not a hand-written tag`).not.toContain(
        'theme-preload.js',
      );
    });
  });

  describe('CSS fallback', () => {
    it('paints the canvas from `html`, not just `body`', () => {
      // The compositor fills the canvas from `html` before `body` has layout, so
      // a themed `body` alone still shows the browser default first.
      expect(CSS).toMatch(/html\s*{[^}]*background-color:\s*var\(--color-background\)/);
    });

    it('falls back to dark for an OS-dark system preference', () => {
      expect(CSS).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*html:not\(\[data-theme\]\)/);
    });

    it('scopes the fallback so it cannot outlive the real paint', () => {
      // Without `:not([data-theme])` this would keep overriding the palette
      // after `applyTheme` ran, breaking the light and midnight themes.
      const start = CSS.indexOf('html:not([data-theme])');
      expect(start).toBeGreaterThan(-1);
      const block = CSS.slice(start, CSS.indexOf('}', start));
      expect(block).toContain('color-scheme: dark');
    });

    it('declares `color-scheme` on the dark palette', () => {
      // Native scrollbars and form controls are outside token reach and stay
      // light without this.
      const start = CSS.indexOf('.dark {');
      const block = CSS.slice(start, CSS.indexOf('}', start));
      expect(block).toContain('color-scheme: dark');
    });
  });

  describe('render gate', () => {
    it('paints the theme before mounting React', () => {
      const bootstrap = readFileSync(resolve(__dirname, '../lib/page-bootstrap.ts'), 'utf8');
      expect(bootstrap).toContain('applyTheme');
      // One read feeding both concerns: language and theme share `uiSettings`,
      // and reading it twice made cold start the sum of two round trips.
      expect(bootstrap.match(/getUISettings/g)?.length).toBe(1);
      expect(bootstrap).toContain('applyLanguage');
    });

    it.each(ENTRYPOINTS)('gates the %s render on bootstrapPage', (name) => {
      const main = readFileSync(resolve(__dirname, `../entrypoints/${name}/main.tsx`), 'utf8');
      expect(main).toContain('bootstrapPage()');
      expect(main).not.toContain('initI18nFromStorage');
    });

    it('does not block the side panel on MCP connections', () => {
      // `ExternalMcpServer.connect()` fetches with no timeout, so awaiting MCP
      // init before render let one unreachable server hold the panel blank
      // indefinitely.
      const main = readFileSync(resolve(__dirname, '../entrypoints/sidepanel/main.tsx'), 'utf8');
      const gate = main.slice(main.indexOf('bootstrapPage()'));
      expect(gate).not.toContain('initBuiltinMcpServers');
      expect(main).toContain('initBuiltinMcpServers()');
    });
  });
});

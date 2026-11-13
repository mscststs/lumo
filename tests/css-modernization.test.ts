import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Layout / CSS modernization guards.
 *
 * Each case here was a real, verified problem — the kind that a screenshot at
 * the default zoom never shows:
 *
 * - Arbitrary `text-[10px]` sizes are px, so they ignore the app's own
 *   font-size setting (`lib/font-size.ts` writes `html { font-size }` and every
 *   other size is rem).
 * - `h-screen` is `100vh`: the *large* viewport, which is taller than the
 *   visible area while browser chrome is showing.
 * - `::-webkit-scrollbar` rules declared next to `scrollbar-color`/`-width` are
 *   ignored by Blink once the standard properties are set, so the hover state
 *   and the inset pill silently did nothing.
 * - Scrollbar thumbs at 25% alpha composite to ~1.8:1, below the 3:1 that
 *   WCAG 1.4.11 asks of a non-text affordance.
 * - Headings and narrow paragraphs had no `text-wrap` policy at all.
 */

const ROOT = resolve(__dirname, '..');
const CSS = readFileSync(join(ROOT, 'assets/globals.css'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const TSX = [...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'entrypoints'))];
const read = (file: string) => readFileSync(file, 'utf8');

describe('typography and viewport units', () => {
  it('never pins a font size to px', () => {
    const offenders = TSX.filter((file) => /text-\[\d+(\.\d+)?px\]/.test(read(file))).map(
      (file) => file.replace(`${ROOT}/`, ''),
    );
    expect(offenders).toEqual([]);
  });

  it('sizes full-height pages with dynamic viewport units', () => {
    const offenders = TSX.filter((file) => /\bh-screen\b/.test(read(file))).map((file) =>
      file.replace(`${ROOT}/`, ''),
    );
    expect(offenders).toEqual([]);
  });

  it('balances headings and prettifies body copy', () => {
    expect(CSS).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*text-wrap:\s*balance;/);
    expect(CSS).toMatch(/text-wrap:\s*pretty;/);
  });
});

describe('scrollbars', () => {
  const utility = CSS.slice(CSS.indexOf('@utility scrollbar-lumo'));

  it('drives the standard properties and gates the webkit fallback', () => {
    expect(utility).toContain('scrollbar-width: thin');
    expect(utility).toContain('scrollbar-color: var(--color-scrollbar-thumb) transparent');
    // The fallback must be *inside* the support query: declared unconditionally
    // beside the standard properties, Blink ignores it.
    const supportsAt = utility.indexOf('@supports not (scrollbar-color: auto)');
    const webkitAt = utility.indexOf('&::-webkit-scrollbar');
    expect(supportsAt).toBeGreaterThan(-1);
    expect(webkitAt).toBeGreaterThan(supportsAt);
  });

  it('keeps the thumb above the 3:1 non-text contrast floor', () => {
    // Alpha is a proxy here: 0.7 of the muted grey composites to ~3.1:1 on the
    // light background. Anything below 0.5 was measurably invisible.
    const thumb = /--color-scrollbar-thumb:\s*hsl\([^)]*\/\s*([\d.]+)\)/.exec(CSS);
    expect(thumb).not.toBeNull();
    expect(Number(thumb![1])).toBeGreaterThanOrEqual(0.6);
  });
});

describe('forced colours', () => {
  it('gives surfaces a system border and keeps focus visible', () => {
    expect(CSS).toMatch(/@media \(forced-colors: active\)/);
    const block = CSS.slice(CSS.indexOf('@media (forced-colors: active)'));
    expect(block).toContain('border-color: CanvasText');
    expect(block).toContain('outline-color: Highlight');
  });
});

describe('size-aware layout', () => {
  it('makes each split-view panel its own container', () => {
    const split = readFileSync(join(ROOT, 'components/chat/SplitView.tsx'), 'utf8');
    // A panel is narrower than the viewport whenever the user splits, so panel
    // interiors must be able to query their own width.
    expect(split).toContain('@container/panel');
  });

  it('collapses the options navigation to an icon rail instead of overflowing', () => {
    const app = readFileSync(join(ROOT, 'entrypoints/options/App.tsx'), 'utf8');
    expect(app).toContain('w-14 lg:w-56');
    // The icon rail hides the label, so the name has to survive elsewhere.
    expect(app).toMatch(/aria-label=\{label\}/);
    expect(app).toMatch(/aria-current=\{active \? 'page' : undefined\}/);
  });

  it('reserves the scrollbar gutter on the transcript', () => {
    const conversation = readFileSync(
      join(ROOT, 'components/ai-elements/conversation.tsx'),
      'utf8',
    );
    expect(conversation).toContain('[scrollbar-gutter:stable]');
  });
});

describe('interactive semantics', () => {
  it('does not attach click handlers to divs for primary actions', () => {
    // Row disclosure headers, file preview and image expand are all buttons now;
    // a clickable div is neither focusable nor activatable from the keyboard.
    const offenders: string[] = [];
    for (const file of TSX) {
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // Only the opening tag counts: `[^>]*` cannot leak into a child element.
      const re = /<div\b[^>]*?\bonClick=\{/g;
      for (const match of source.matchAll(re)) {
        // `stopPropagation` wrappers around a real control are fine: the div
        // itself is not the target of the user's intent. `=>` truncates the
        // opening-tag match, so the rest of the line is inspected instead.
        const openingLine = source.slice(match.index).split('\n')[0] ?? '';
        if (openingLine.includes('stopPropagation')) continue;
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file.replace(`${ROOT}/`, '')}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('enlarges sub-24px icon targets in the file row', () => {
    const files = readFileSync(join(ROOT, 'components/chat/ConversationFiles.tsx'), 'utf8');
    // WCAG 2.2 (2.5.8) asks for at least 24x24.
    expect(files).not.toMatch(/className="h-5 w-5 rounded"/);
    expect(files).toContain('className="h-6 w-6 rounded"');
  });
});

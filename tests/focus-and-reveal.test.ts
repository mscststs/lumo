import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Focus visibility and hover-revealed controls.
 *
 * Two regressions are pinned here, because both were invisible to the test
 * suite while being plainly broken in a browser:
 *
 * 1. **The global focus reset ate every ring.** `assets/globals.css` carried
 *    `*:focus-visible:not([role="listbox"]) { outline: none !important;
 *    box-shadow: none !important }`. A Tailwind v4 `ring-*` utility is a
 *    `box-shadow`, and `!important` outranks every utility, so the rule deleted
 *    the very indicator components were painting for themselves. Every button,
 *    input, textarea, switch, tab and select trigger had no keyboard focus
 *    indicator (WCAG 2.4.7).
 *
 * 2. **Hover-only affordances were unreachable.** `opacity-0 group-hover:*`
 *    leaves a control invisible on touch devices (no hover exists) and invisible
 *    to keyboard users (focus does not cancel `opacity`). Attachments could not
 *    be removed and files could not be referenced without a mouse.
 */

const ROOT = resolve(__dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/** Source with comments stripped so prose about the old bug is not a hit. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const SOURCE_FILES = [
  ...walk(join(ROOT, 'components')),
  ...walk(join(ROOT, 'entrypoints')),
];

describe('global focus styles', () => {
  const css = code('assets/globals.css');

  it('never suppresses focus with !important', () => {
    // The exact shape of the old reset. Any `!important` box-shadow/outline
    // removal on a focus selector silently defeats component-level rings.
    expect(css).not.toMatch(/box-shadow:\s*none\s*!important/);
    expect(css).not.toMatch(/\*\s*\{[^}]*outline:\s*none\s*!important/);
  });

  it('silences pointer focus but keeps a keyboard indicator', () => {
    expect(css).toMatch(/:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none;?\s*\}/);
    expect(css).toMatch(/:where\(:focus-visible:not\(\[tabindex='-1'\]\)\)/);
  });

  it('keeps the indicator overridable and skips programmatically focused panels', () => {
    const block = css.slice(css.indexOf(':where(:focus-visible'));
    // `:where()` contributes zero specificity, so one utility can override it.
    expect(block).toContain('outline: 2px solid var(--color-ring)');
    // Radix parks focus on dialog/listbox containers (`tabindex="-1"`); ringing
    // those would read as if the panel were an editable field.
    expect(block).toContain("[tabindex='-1']");
  });
});

describe('component focus styles', () => {
  // The global rule is the single source of the indicator; restating a ring in
  // a component would paint a second one (and used to paint none).
  const ringUsers = SOURCE_FILES.filter((file) => {
    const source = code(file).replace(/^\s*\/\/.*$/gm, '');
    return /focus(-visible)?:ring-/.test(source);
  });

  it('does not restate focus rings that the global rule already draws', () => {
    expect(ringUsers.map((file) => file.replace(`${ROOT}/`, ''))).toEqual([]);
  });
});

describe('hover-revealed controls', () => {
  /**
   * Any `opacity-0 … group-hover:opacity-100` pair must be expressed with
   * `reveal-on-hover`, which defaults to visible on non-hover pointers. This
   * guards the three states that matter: hover, keyboard focus inside the
   * group, and touch.
   */
  const offenders: string[] = [];

  for (const file of SOURCE_FILES) {
    const source = code(file);
    // Two shapes of the same bug: a hidden-until-hover cluster written with a
    // bare `opacity-0`, or the same thing gated on a *width* breakpoint
    // (`sm:opacity-0`), which hides the controls on tablet-width touch screens
    // where no hover exists either.
    const pair = /(?:^|[^:a-z-])opacity-0[^'"`\n]*group-hover[:/][^'"`\n]*opacity-100/g;
    for (const match of source.matchAll(pair)) {
      const line = source.slice(0, match.index).split('\n').length;
      if (!match[0].includes('reveal-on-hover') && !source.includes('reveal-on-hover')) {
        offenders.push(`${file.replace(`${ROOT}/`, '')}:${line}`);
      }
    }
    // A revealed control is only keyboard-reachable if focus inside the group
    // (or the control itself) cancels the hidden state.
    for (const match of source.matchAll(/reveal-on-hover[^'"`\n]*/g)) {
      if (!/(group-focus-within(\/[a-z-]+)?|focus-visible):opacity/.test(match[0])) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file.replace(`${ROOT}/`, '')}:${line} (no focus reveal)`);
      }
    }
  }

  it('reveals on hover, focus and touch rather than hover alone', () => {
    expect(offenders).toEqual([]);
  });

  it('defines the reveal utility without a hover-only default', () => {
    const css = code('assets/globals.css');
    const start = css.indexOf('@utility reveal-on-hover');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', css.indexOf('@media', start)) + 1);
    // Default is visible; hiding is scoped to fine pointers.
    expect(block).toMatch(/opacity:\s*1/);
    expect(block).toMatch(/@media \(hover: hover\) and \(pointer: fine\)/);
  });
});

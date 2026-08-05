import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dialog enter/exit animation.
 *
 * Regression guard for a positioning bug: the panel used to be centred with
 * `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2` while the
 * `lumo-dialog-in` keyframe animated `transform: translate(-50%,-50%) scale()`.
 *
 * In Tailwind v4 `-translate-x-1/2` no longer compiles to `transform`; it sets
 * the standalone `translate` property (`translate: -50% -50%`). CSS applies
 * `translate` *and* `transform` cumulatively, so during the animation the panel
 * was displaced by -100%/-100% — visibly parked at the top-left corner — and
 * only snapped to centre once the animation finished and `transform` reverted.
 *
 * The fix centres the panel with a flex wrapper so the keyframes only touch
 * opacity and scale. These tests assert both halves of that contract.
 */

const CSS = readFileSync(resolve(__dirname, '../assets/globals.css'), 'utf8');
const DIALOG = readFileSync(resolve(__dirname, '../components/ui/dialog.tsx'), 'utf8');

/** Source with comments removed, so prose describing the old bug is not a hit. */
const DIALOG_CODE = DIALOG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Body of a `@keyframes` block by name. */
function keyframes(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name}`);
  expect(start, `no @keyframes ${name}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  // Walk braces to find the matching close, since keyframes nest one level.
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(open, i + 1);
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

describe('dialog keyframes', () => {
  it.each(['lumo-dialog-in', 'lumo-dialog-out'])(
    '%s does not translate the panel',
    (name) => {
      // The specific regression: any `translate()` in the transform fights the
      // standalone `translate` property Tailwind v4 emits.
      expect(keyframes(name)).not.toMatch(/translate/);
    },
  );

  it.each(['lumo-dialog-in', 'lumo-dialog-out'])('%s animates opacity', (name) => {
    expect(keyframes(name)).toContain('opacity');
  });

  it('fades in from a near-full scale rather than sliding', () => {
    const block = keyframes('lumo-dialog-in');
    const scales = [...block.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(scales.length).toBeGreaterThan(0);
    // A pronounced zoom reads as a jump; keep it subtle so the motion is a fade.
    for (const scale of scales) expect(scale).toBeGreaterThanOrEqual(0.9);
  });
});

describe('dialog centring', () => {
  it('centres via a flex wrapper, not translate utilities', () => {
    expect(DIALOG_CODE).toMatch(/items-center/);
    expect(DIALOG_CODE).toMatch(/justify-center/);
    // These are what conflicted with the keyframes.
    expect(DIALOG_CODE).not.toContain('-translate-x-1/2');
    expect(DIALOG_CODE).not.toContain('-translate-y-1/2');
    expect(DIALOG_CODE).not.toContain('left-1/2');
    expect(DIALOG_CODE).not.toContain('top-1/2');
  });

  it('keeps the full-screen wrapper click-through so the backdrop stays usable', () => {
    // The wrapper covers the viewport above the overlay. Without
    // `pointer-events-none` it would eat every click-outside, so Radix would
    // never see the backdrop press and the dialog could not be dismissed.
    expect(DIALOG_CODE).toContain('pointer-events-none');
    // ...and the panel itself must opt back in, or its own controls go dead.
    expect(DIALOG_CODE).toContain('pointer-events-auto');
  });

  it('still constrains width and height', () => {
    expect(DIALOG_CODE).toContain('max-w-md');
    expect(DIALOG_CODE).toMatch(/max-h-\[calc\(100dvh/);
  });
});

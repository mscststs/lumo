import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Affordances that must work without a mouse.
 *
 * The behavioural side of this is `tests/touch-disclosure.test.tsx`; this file
 * pins the *shape* of the fixes, because both bugs it guards were silent: the
 * component looked right, and only a real touchscreen showed that the panel
 * could not be opened or the divider could not be dragged.
 *
 * 1. Information panels go through `Hint`, never a bare tooltip. Radix's
 *    tooltip is hover-only by design, so a `Tooltip` import in the chat surface
 *    is a control that does nothing on a phone.
 * 2. The split-view divider is pointer-driven. It used `onMouseDown` +
 *    document `mousemove`, so two split panels could not be resized by touch.
 * 3. A glyph revealed on hover has a rest state off hover (`reveal-*`
 *    utilities), instead of `opacity-0` that never clears.
 */

const ROOT = resolve(__dirname, '..');

function code(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
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

describe('touch-reachable information panels', () => {
  it('routes every chat-surface panel through Hint instead of a bare tooltip', () => {
    const offenders = walk(join(ROOT, 'components/chat'))
      .filter((file) => /from '@\/components\/ui\/tooltip'/.test(code(file)))
      .map((file) => file.replace(`${ROOT}/`, ''));

    // A tooltip in this directory means a panel that only opens on hover.
    expect(offenders).toEqual([]);
  });

  it('gives each panel an explicitly named touch-mode dialog', () => {
    for (const path of [
      'components/chat/TokenUsageTooltip.tsx',
      'components/chat/ContextUsageRing.tsx',
      'components/chat/MessageTimestamp.tsx',
    ]) {
      expect(code(path)).toMatch(/<Hint\b/);
      expect(code(path)).toMatch(/contentLabel=/);
    }
  });

  it('keeps the timestamp interactive in tap mode', () => {
    const source = code('components/chat/MessageTimestamp.tsx');
    // A tap target has to be a button; a `<time>` with a click handler is text
    // to assistive tech and never reaches a control list.
    expect(source).toMatch(/mode === 'tap' \? \(\s*<button/);
    expect(source).toMatch(/provider="inherit"/);
  });
});

describe('pointer-driven split-view divider', () => {
  const source = code('components/chat/SplitView.tsx');

  it('listens to pointer events rather than mouse events', () => {
    expect(source).toMatch(/onPointerDown=\{\(e\) => handleDividerPointerDown/);
    expect(source).toMatch(/document\.addEventListener\('pointermove'/);
    expect(source).toMatch(/document\.addEventListener\('pointerup'/);
    // A cancelled gesture (a call, the browser claiming the touch) must end the
    // drag too, or the next move keeps resizing with no finger down.
    expect(source).toMatch(/document\.addEventListener\('pointercancel'/);
    expect(source).not.toMatch(/onMouseDown=/);
    expect(source).not.toMatch(/addEventListener\('mousemove'/);
  });

  it('claims the gesture and offers a finger-sized hit area', () => {
    const divider = source.slice(source.indexOf('cursor-col-resize'));
    // `touch-none` stops the browser turning the drag into a scroll.
    expect(divider).toContain('touch-none');
    // The rail is 8px wide; the pseudo element widens the hit area without
    // changing the layout width every panel's math depends on.
    expect(divider).toContain('before:-inset-x-1');
  });
});

describe('faint hover reveals', () => {
  it('keeps the queued-message withdraw glyph visible off hover', () => {
    expect(code('components/chat/ChatInput.tsx')).toMatch(
      /reveal-faint-on-hover group-hover:opacity-60/,
    );
  });

  it('defines the utility with a visible default and a fine-pointer hide', () => {
    const css = code('assets/globals.css');
    const start = css.indexOf('@utility reveal-faint-on-hover');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', css.indexOf('@media', start)) + 1);
    expect(block).toMatch(/opacity:\s*0\.6/);
    expect(block).toMatch(/@media \(hover: hover\) and \(pointer: fine\)/);
  });
});

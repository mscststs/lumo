import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { commitOnEnter, isImeConfirming } from '@/lib/enter-submit';

/**
 * Two "same fact, many places" guards.
 *
 * 1. **IME-safe Enter.** An IME confirms its candidate with Enter. A handler that
 *    only looks at `key === 'Enter'` commits mid-composition — the value is
 *    submitted twice, or a half-converted value is written back. `isComposing`
 *    is the standard signal; `keyCode === 229` covers Safari's event-ordering
 *    bug (WebKit #165004), where `compositionend` runs before the confirming
 *    `keydown` and `isComposing` has already been reset.
 *
 * 2. **One tooltip surface.** Three files used to import
 *    `@radix-ui/react-tooltip` directly, each with its own delay and its own
 *    animation classes — and those classes (`animate-in`, `fade-in-0`) belong to
 *    `tailwindcss-animate`, which this project does not compile. The tooltips
 *    were the only floating surfaces with no motion at all.
 */

const ROOT = resolve(__dirname, '..');

/** A React-like synthetic event is unnecessary: the helper only reads `nativeEvent`. */
function enterEvent(native: { isComposing?: boolean; keyCode?: number }, key = 'Enter') {
  return { key, nativeEvent: native } as unknown as React.KeyboardEvent;
}

describe('isImeConfirming', () => {
  it('reports a composing Enter', () => {
    expect(isImeConfirming(enterEvent({ isComposing: true, keyCode: 229 }))).toBe(true);
  });

  it('reports the legacy VK_PROCESSKEY keycode even when isComposing is already false', () => {
    // Safari's ordering bug: compositionend has run, isComposing is false.
    expect(isImeConfirming(enterEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it('treats a plain Enter as a commit', () => {
    expect(isImeConfirming(enterEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });
});

describe('commitOnEnter', () => {
  it('commits a plain Enter and prevents the default action', () => {
    const commit = vi.fn();
    const event = enterEvent({ isComposing: false, keyCode: 13 });
    const preventDefault = vi.fn();
    (event as unknown as { preventDefault: () => void }).preventDefault = preventDefault;

    expect(commitOnEnter(event, commit)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('leaves an IME-confirming Enter entirely alone', () => {
    const commit = vi.fn();
    const event = enterEvent({ isComposing: true, keyCode: 229 });
    const preventDefault = vi.fn();
    (event as unknown as { preventDefault: () => void }).preventDefault = preventDefault;

    expect(commitOnEnter(event, commit)).toBe(false);
    // The browser must still be allowed to accept the candidate, so the default
    // action is *not* prevented.
    expect(preventDefault).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const commit = vi.fn();
    expect(commitOnEnter(enterEvent({}, 'Escape'), commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
});

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const SOURCE_FILES = [...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'entrypoints'))];

describe('enter-to-commit call sites', () => {
  const fields = [
    'entrypoints/options/components/ContextWindowField.tsx',
    'entrypoints/options/components/MaxStepsField.tsx',
    'entrypoints/options/components/PasteThresholdField.tsx',
    'entrypoints/options/components/TokenBudgetField.tsx',
  ];

  it.each(fields)('%s routes Enter through the shared IME-safe helper', (file) => {
    const source = read(file);
    expect(source).toContain('commitOnEnter');
    // A bare `if (e.key === 'Enter')` next to `preventDefault` is the shape that
    // breaks IME input; the helper is the only place allowed to spell it.
    expect(source).not.toMatch(/if \(e\.key === 'Enter'\) \{\s*e\.preventDefault\(\)/);
  });
});

describe('tooltip surface', () => {
  it('is imported from exactly one module', () => {
    const importers = SOURCE_FILES.filter((file) =>
      /from '@radix-ui\/react-tooltip'/.test(read(file)),
    ).map((file) => file.replace(`${ROOT}/`, ''));
    expect(importers).toEqual(['components/ui/tooltip.tsx']);
  });

  it('does not rely on tailwindcss-animate classes that are never compiled', () => {
    const offenders = SOURCE_FILES.filter((file) => /\banimate-in\b|\bfade-in-0\b/.test(read(file)))
      .map((file) => file.replace(`${ROOT}/`, ''));
    expect(offenders).toEqual([]);
  });

  it('animates through the shared data-state keyframes', () => {
    const css = read('assets/globals.css');
    expect(css).toMatch(/\.tooltip-panel\[data-state='(delayed-open|instant-open)'\]/);
    expect(css).toMatch(/\.tooltip-panel\[data-state='closed'\]/);
    // And honours reduced motion, like the dialog/popover keyframes.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.tooltip-panel');
  });
});

describe('motion preferences', () => {
  it('lets motion honour the OS reduce-motion setting', () => {
    const provider = read('components/direction-provider.tsx');
    expect(provider).toContain('MotionConfig');
    expect(provider).toContain('reducedMotion="user"');
  });
});

describe('image hints', () => {
  it.each([
    'components/chat/MessagePartList.tsx',
    'components/chat/MessageBubble.tsx',
    'components/chat/ChatInput.tsx',
    'components/ai-elements/tool-primitives.tsx',
  ])('%s declares decoding for transcript images', (file) => {
    const source = read(file);
    // `dataTransfer.setData('text/html', '<img …>')` builds markup strings, not
    // rendered elements; only JSX tags are checked here.
    const images = (source.match(/<img[\s\S]*?\/>/g) ?? []).filter(
      (tag) => !tag.includes('${'),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image, `every <img> in ${file} should declare decoding`).toContain('decoding=');
    }
  });
});

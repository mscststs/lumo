// @vitest-environment jsdom
/**
 * One settings column, one control width.
 *
 * Two things had drifted on the personalisation page: the controls themselves
 * came in three widths (`w-36`/`w-40`/`w-52`/`w-56`), and each dropdown panel
 * sized itself to its longest option — so a menu with a keycap badge or a
 * two-word label in a long locale stuck out past every neighbour. Panels are now
 * pinned to their trigger's width (`ui/select`) and the page uses a single width
 * for every control in the column.
 *
 * The send-key badge is part of the same complaint: it printed all three
 * accepted modifiers on one line, which alone made its menu the widest thing on
 * the page. It shows one representative modifier now.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SendKeyBadge } from '@/entrypoints/options/components/SendKeyBadge';

afterEach(cleanup);

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('select panel geometry', () => {
  it('pins the panel to the control width and ellipsizes long options', () => {
    const select = read('components/ui/select.tsx');
    // Panels used to grow to fit their longest item, so two selects in one
    // column could differ by 100px.
    expect(select).toContain('w-[var(--radix-select-trigger-width)]');
    // Truncation is what makes a fixed width survivable in long locales.
    expect(select).toMatch(/SelectPrimitive\.ItemText className="truncate"/);
  });

  it('keeps the per-caller escape hatch for genuinely wide menus', () => {
    // The model picker sets `min-w-*`; a fixed width must not win over it.
    const header = read('components/chat/ChatHeader.tsx');
    expect(header).toContain('min-w-[13rem]');
  });
});

describe('personalisation page control widths', () => {
  /** Every `<SelectTrigger>` width, in source order. */
  function triggerWidths(path: string): string[] {
    return [...read(path).matchAll(/<SelectTrigger\b[^>]*className="([^"]+)"/g)]
      .map((match) => /\bw-[\w[\]().-]+/.exec(match[1]!)?.[0])
      .filter((width): width is string => Boolean(width));
  }

  it('uses one width for every select in the column', () => {
    const widths = [
      ...triggerWidths('entrypoints/options/UISettings.tsx'),
      ...triggerWidths('entrypoints/options/components/PasteThresholdField.tsx'),
    ];
    expect(widths.length).toBeGreaterThan(10);
    expect(new Set(widths)).toEqual(new Set(['w-40']));
  });

  it('gives the language button the same width as the selects beside it', () => {
    // It opens a searchable dialog instead of a menu, but it sits in the same
    // column — a wider trigger reads as a different kind of control.
    expect(read('components/ui/language-picker.tsx')).toContain("'h-10 w-40 ");
  });
});

describe('send-key badge', () => {
  it('shows one modifier plus Enter for the modifier shortcut', () => {
    const { container } = render(<SendKeyBadge value="meta-enter" />);

    const caps = container.querySelectorAll('kbd');
    expect(caps).toHaveLength(2);
    expect(caps[0]!.textContent).toMatch(/^(⌘|Ctrl)$/);
    expect(container.textContent).toContain('+');
    // The Enter cap is announced rather than being an unlabelled icon.
    expect(container.textContent).toContain('Enter');
    // The slash-separated cluster of three modifiers is gone.
    expect(container.textContent).not.toContain('/');
  });

  it('shows only Enter for the plain shortcut', () => {
    const { container } = render(<SendKeyBadge value="enter" />);

    expect(container.querySelectorAll('kbd')).toHaveLength(1);
    expect(container.textContent).toContain('Enter');
    expect(container.textContent).not.toContain('+');
  });
});

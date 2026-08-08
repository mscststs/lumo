// @vitest-environment jsdom
/**
 * The chat debug panel switcher must mirror the sidebar it describes.
 *
 * Two things have to agree, and they are easy to get subtly wrong in opposite
 * directions:
 *
 * 1. **Order.** The buttons sit left to right in the same arrangement as the
 *    panels. Sorting them "primary first" inverts the control relative to the
 *    sidebar, putting the button labelled "Left" on the right.
 * 2. **Labels.** Left/Middle/Right come from a panel's *position*, never from its
 *    storage slot. The two used to coincide; now that panels can be reordered,
 *    deriving a label from the slot id names the wrong side.
 *
 * Both were regressions during the slot/position split, and neither is visible
 * from the code alone — hence asserting the rendered order directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'options.chatDebug.panelLeft': 'Left',
        'options.chatDebug.panelMiddle': 'Middle',
        'options.chatDebug.panelRight': 'Right',
        'options.chatDebug.panelSelect': 'Panel',
      };
      return labels[key] ?? key;
    },
  }),
}));

/** The visible layout the side panel has published. */
let visibleOrder: number[] = [0];

vi.mock('@/store/storage', () => ({
  storage: {
    getSplitViewVisible: async () => ({ order: visibleOrder }),
  },
}));

vi.mock('@/store/useStorageWatch', () => ({ useStorageWatch: () => {} }));
vi.mock('@/lib/conversation-store', () => ({ getConversation: async () => null }));

vi.mock('@/entrypoints/options/components/SettingsHeader', () => ({
  SettingsHeader: () => null,
}));

beforeEach(() => {
  visibleOrder = [0];
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
});

afterEach(cleanup);

async function renderDebugPage() {
  const { ChatDebugPage } = await import('@/entrypoints/options/ChatDebug');
  const utils = render(<ChatDebugPage />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return utils;
}

/** The switcher button labels, in the order they are laid out on screen. */
function switcherLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')]
    .map((button) => button.textContent?.trim() ?? '')
    .filter((label) => ['Left', 'Middle', 'Right'].includes(label));
}

describe('panel switcher layout', () => {
  it('lays the buttons out left to right, matching the sidebar', async () => {
    // Default order [2,1,0]: slot 2 leftmost, slot 0 rightmost. The button
    // labelled "Right" must therefore come last, not first.
    visibleOrder = [2, 1, 0];
    const { container } = await renderDebugPage();

    expect(switcherLabels(container)).toEqual(['Left', 'Middle', 'Right']);
  });

  it('lays out two panels left to right', async () => {
    visibleOrder = [1, 0];
    const { container } = await renderDebugPage();

    expect(switcherLabels(container)).toEqual(['Left', 'Right']);
  });

  it('keeps the visual order after a reorder puts a high slot on the right', async () => {
    // Slot 1 has been dragged rightmost. The arrangement on screen is unchanged —
    // still Left/Middle/Right — because the labels describe positions.
    visibleOrder = [0, 2, 1];
    const { container } = await renderDebugPage();

    expect(switcherLabels(container)).toEqual(['Left', 'Middle', 'Right']);
  });

  it('hides the switcher when only one panel is open', async () => {
    visibleOrder = [0];
    const { container } = await renderDebugPage();

    expect(switcherLabels(container)).toEqual([]);
  });
});

describe('panel labels follow position, not slot', () => {
  /** Maps each label to the slot its button selects, via `data-slot`-free DOM order. */
  function labelToSlot(container: HTMLElement, order: number[]): Record<string, number> {
    const labels = switcherLabels(container);
    const out: Record<string, number> = {};
    labels.forEach((label, index) => { out[label] = order[index]!; });
    return out;
  }

  it('names slot 0 the right panel in the default layout', async () => {
    visibleOrder = [2, 1, 0];
    const { container } = await renderDebugPage();

    expect(labelToSlot(container, visibleOrder)).toEqual({ Left: 2, Middle: 1, Right: 0 });
  });

  it('names the reordered rightmost slot the right panel', async () => {
    // The regression this guards: with slot-derived labels, slot 0 would still be
    // called "Right" while sitting on the left.
    visibleOrder = [0, 2, 1];
    const { container } = await renderDebugPage();

    expect(labelToSlot(container, visibleOrder)).toEqual({ Left: 0, Middle: 2, Right: 1 });
  });

  it('names a reordered two-panel layout by position', async () => {
    visibleOrder = [0, 1];
    const { container } = await renderDebugPage();

    expect(labelToSlot(container, visibleOrder)).toEqual({ Left: 0, Right: 1 });
  });
});

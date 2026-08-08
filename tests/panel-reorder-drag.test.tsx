// @vitest-environment jsdom
/**
 * Reordering panels by dragging must be purely visual.
 *
 * The geometry is covered as pure functions in `panel-drag-geometry.test.ts`;
 * this covers the wiring, and above all the four things a reorder must never do
 * to a running conversation:
 *
 * 1. remount a panel — that aborts its request and discards its input draft;
 * 2. change a panel's slot — slots are storage keys, and `useConversations`
 *    re-reads its conversation when its key changes;
 * 3. move a DOM node — Chrome resets `scrollTop` on the scrollable descendants
 *    of a moved node, jumping the transcript to the bottom;
 * 4. touch per-panel storage — nothing about a panel's data depends on position.
 *
 * Each of these fails silently: the layout looks correct and the conversation
 * breaks, which is why they are asserted directly rather than through the UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import type { ChatPanelHandle } from '@/components/chat/ChatPanel';

const mounts: number[] = [];
const unmounts: number[] = [];
const lastProps = new Map<number, Record<string, unknown>>();
/** Every distinct `panelIndex` each panel element has been rendered with. */
const slotHistory = new Map<number, number[]>();
/** How many times each panel re-rendered, to catch churn during a drag. */
const renderCounts = new Map<number, number>();

vi.mock('@/components/chat/ChatPanel', () => ({
  ChatPanel: forwardRef<ChatPanelHandle, Record<string, unknown>>(function StubPanel(props, ref) {
    const slot = props.panelIndex as number;
    lastProps.set(slot, { ...props });
    renderCounts.set(slot, (renderCounts.get(slot) ?? 0) + 1);
    const seen = slotHistory.get(slot) ?? [];
    if (seen[seen.length - 1] !== slot) seen.push(slot);
    slotHistory.set(slot, seen);

    useEffect(() => {
      mounts.push(slot);
      return () => { unmounts.push(slot); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      addImages: vi.fn(),
      addTextAttachment: vi.fn(),
      focus: vi.fn(),
      getCurrentSessionId: () => null,
      getRoutingState: () => ({ isStreaming: false, hasContent: false }),
      applyQuickAction: vi.fn(),
    }));

    // A header stand-in, so the drag can be started the way the real UI does.
    return (
      <div data-testid={`panel-${slot}`} data-slot={slot}>
        <div
          data-testid={`header-${slot}`}
          onPointerDown={props.onReorderPointerDown as React.PointerEventHandler}
        />
      </div>
    );
  }),
}));

let storedOrder: number[] = [2, 1, 0];
const setLayout = vi.fn(async (layout: { order: number[] }) => {
  storedOrder = layout.order;
});

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => ({
      language: 'en',
      theme: 'light',
      maxSplitPanels: 3,
      sendKey: 'enter',
    }),
    getSplitViewLayout: async () => ({ order: storedOrder }),
    setSplitViewLayout: (layout: { order: number[] }) => setLayout(layout),
    setSplitViewVisible: async () => {},
  },
}));

vi.mock('@/store/useStorageWatch', () => ({ useStorageWatch: () => {} }));
vi.mock('@/store/useContextMenuPending', () => ({ useContextMenuPending: () => {} }));

const releasePanelSlot = vi.fn(async (_area: unknown, _slot: number) => {});
const openPanelSlot = vi.fn(async (_area: unknown, _slot: number) => {});
vi.mock('@/lib/panel-storage', () => ({
  releasePanelSlot: (area: unknown, slot: number) => releasePanelSlot(area, slot),
  openPanelSlot: (area: unknown, slot: number) => openPanelSlot(area, slot),
}));

function stubContainerWidth(width: number) {
  class WidthObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = WidthObserver as unknown as typeof ResizeObserver;
}

/** Container width used throughout: 1200 available over 3 panels = 400 each. */
const CONTAINER_WIDTH = 1200 + 2 * 8;

beforeEach(() => {
  mounts.length = 0;
  unmounts.length = 0;
  lastProps.clear();
  slotHistory.clear();
  renderCounts.clear();
  setLayout.mockClear();
  releasePanelSlot.mockClear();
  openPanelSlot.mockClear();
  storedOrder = [2, 1, 0];
  stubContainerWidth(CONTAINER_WIDTH);
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), remove: async () => {} },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { openOptionsPage: vi.fn() },
  };
});

afterEach(cleanup);

async function settle(ms = 60) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function renderSplitView() {
  const { SplitView } = await import('@/components/chat/SplitView');
  const utils = render(<SplitView />);
  await settle();
  return utils;
}

/** `data-slot` of every panel in DOM order. */
function domSlotOrder(container: HTMLElement): number[] {
  return [...container.querySelectorAll('[data-slot]')].map((el) =>
    Number(el.getAttribute('data-slot')),
  );
}

/** The wrapper element for a slot — the node carrying `order` and the transform. */
function wrapperFor(container: HTMLElement, slot: number): HTMLElement {
  const panel = container.querySelector(`[data-slot="${slot}"]`);
  // stub root → flex-1 wrapper → motion.div
  return panel?.parentElement?.parentElement as HTMLElement;
}

/** Visual position of each slot, read from CSS `order`. */
function visualOrder(container: HTMLElement): Record<number, number> {
  const out: Record<number, number> = {};
  for (const el of container.querySelectorAll('[data-slot]')) {
    const slot = Number(el.getAttribute('data-slot'));
    out[slot] = Number(wrapperFor(container, slot).style.order);
  }
  return out;
}

/**
 * Drives a full pointer drag on a panel's header.
 *
 * Dispatched on `document` after the initial `pointerdown`, matching the hook's
 * listeners — the pointer routinely leaves the header it started on.
 */
async function dragPanel(
  container: HTMLElement,
  slot: number,
  deltaX: number,
  { release = true, startX = 500 } = {},
) {
  const header = container.querySelector(`[data-testid="header-${slot}"]`)!;
  await act(async () => {
    header.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: startX, bubbles: true, button: 0 }),
    );
  });
  await act(async () => {
    document.dispatchEvent(
      new PointerEvent('pointermove', { clientX: startX + deltaX, bubbles: true }),
    );
  });
  if (release) {
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await settle(20);
  }
}

describe('dragging a panel to a new position', () => {
  it('commits the new order', async () => {
    // Order [2,1,0]: slot 2 leftmost. Dragging it right past slot 1 (400 wide)
    // needs to cover half of it.
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250);

    expect(setLayout).toHaveBeenCalledWith({ order: [1, 2, 0] });
  });

  it('does not remount, re-slot, or move any DOM node', async () => {
    // The four invariants, in one assertion block. This is the test that would
    // fail if reordering were implemented by reordering React children or by
    // migrating storage between slots.
    const { container } = await renderSplitView();
    const domBefore = domSlotOrder(container);
    mounts.length = 0;

    await dragPanel(container, 2, 250);

    expect(mounts).toEqual([]);
    expect(unmounts).toEqual([]);
    expect(domSlotOrder(container)).toEqual(domBefore);
    for (const [slot, seen] of slotHistory) expect(seen).toEqual([slot]);
    expect(releasePanelSlot).not.toHaveBeenCalled();
    expect(openPanelSlot).not.toHaveBeenCalled();
  });

  it('expresses the new arrangement through CSS order alone', async () => {
    const { container } = await renderSplitView();
    expect(visualOrder(container)).toEqual({ 2: 0, 1: 1, 0: 2 });

    await dragPanel(container, 2, 250);

    // Slot 2 and slot 1 have swapped places visually...
    expect(visualOrder(container)).toEqual({ 1: 0, 2: 1, 0: 2 });
    // ...while the DOM is still in slot order.
    expect(domSlotOrder(container)).toEqual([0, 1, 2]);
  });

  it('hands the role flags to the panels that now hold those positions', async () => {
    // The only UI that may change on a drop: settings/split/close follow position.
    const { container } = await renderSplitView();
    await dragPanel(container, 0, -900); // slot 0 from rightmost to leftmost

    expect(setLayout).toHaveBeenCalledWith({ order: [0, 2, 1] });
    // Slot 1 is now rightmost, so it takes Settings and loses its close button.
    expect(lastProps.get(1)).toMatchObject({ showSettings: true, showClose: false });
    // Slot 0 is now leftmost: it can be closed, and it owns nothing else.
    expect(lastProps.get(0)).toMatchObject({ showSettings: false, showClose: true });
  });

  it('leaves the order alone when the panel is dropped where it started', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 40); // moved, but not past the neighbour midpoint

    expect(setLayout).not.toHaveBeenCalled();
    expect(visualOrder(container)).toEqual({ 2: 0, 1: 1, 0: 2 });
  });

  it('clears the drag transform on drop, so the panel does not stay offset', async () => {
    // If the transform survived the commit, the panel would sit one slot away
    // from where the layout puts it — a visible jump on the next repaint.
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250);

    const transform = wrapperFor(container, 2).style.transform;
    expect(transform === '' || transform === 'none' || /translateX\(0/.test(transform)).toBe(true);
  });
});

describe('a drag below the movement threshold', () => {
  it('is treated as a click, not a reorder', async () => {
    // The header carries buttons and a model picker, so the few pixels of
    // movement inside an ordinary click must not start a drag.
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 2);

    expect(setLayout).not.toHaveBeenCalled();
    expect(lastProps.get(2)?.isDragging).toBeFalsy();
  });
});

describe('abandoning a drag', () => {
  it('restores the original order on Escape', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });
    expect(lastProps.get(2)?.isDragging).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(20);

    expect(setLayout).not.toHaveBeenCalled();
    expect(visualOrder(container)).toEqual({ 2: 0, 1: 1, 0: 2 });
    expect(lastProps.get(2)?.isDragging).toBeFalsy();
  });

  it('restores the original order on pointercancel', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
    });
    await settle(20);

    expect(setLayout).not.toHaveBeenCalled();
    expect(visualOrder(container)).toEqual({ 2: 0, 1: 1, 0: 2 });
  });
});

describe('drag feedback', () => {
  it('marks only the dragged panel, and only while the gesture is live', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 1, 250, { release: false });

    expect(lastProps.get(1)?.isDragging).toBe(true);
    expect(lastProps.get(0)?.isDragging).toBeFalsy();
    expect(lastProps.get(2)?.isDragging).toBeFalsy();

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await settle(20);

    expect(lastProps.get(1)?.isDragging).toBeFalsy();
  });

  it('does not re-render the panel tree on every pointer move', async () => {
    // Offsets are motion values precisely so a drag does not reconcile every
    // transcript. A handful of renders for the drag state is fine; one per frame
    // is not.
    const { container } = await renderSplitView();
    renderCounts.clear();

    const header = container.querySelector('[data-testid="header-2"]')!;
    await act(async () => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { clientX: 500, bubbles: true, button: 0 }),
      );
    });
    for (let i = 1; i <= 40; i++) {
      await act(async () => {
        document.dispatchEvent(
          new PointerEvent('pointermove', { clientX: 500 + i * 5, bubbles: true }),
        );
      });
    }

    // 40 moves must not mean 40 renders of an untouched sibling.
    expect(renderCounts.get(0) ?? 0).toBeLessThan(5);
  });
});

describe('a drag suppresses every other interaction', () => {
  it('prevents the default on pointerdown, killing the native selection drag', async () => {
    // The browser seeds a text selection on `pointerdown`, so preventing it in
    // `pointermove` is too late — sweeping down and across would highlight the
    // transcripts the pointer passes over.
    const { container } = await renderSplitView();
    const header = container.querySelector('[data-testid="header-2"]')!;

    const event = new PointerEvent('pointerdown', {
      clientX: 500,
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => { header.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
  });

  it('locks selection and the cursor document-wide while dragging', async () => {
    // Applied to `<html>`, not the panels: the pointer sweeps over siblings and
    // the gaps between them, and a selection starting in any of those is wrong.
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });

    expect(document.documentElement.style.userSelect).toBe('none');
    expect(document.documentElement.style.cursor).toBe('grabbing');

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await settle(20);

    expect(document.documentElement.style.userSelect).toBe('');
    expect(document.documentElement.style.cursor).toBe('');
  });

  it('does not lock the document for a click that never becomes a drag', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 2);

    expect(document.documentElement.style.userSelect).toBe('');
    expect(document.documentElement.style.cursor).toBe('');
  });

  it('releases the lock when the drag is abandoned', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });
    expect(document.documentElement.style.userSelect).toBe('none');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(20);

    expect(document.documentElement.style.userSelect).toBe('');
    expect(document.documentElement.style.cursor).toBe('');
  });

  it('swallows a click landing at the end of a drag', async () => {
    // Releasing over a button in another panel would otherwise activate it, so a
    // reorder could silently delete a conversation.
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { container.dispatchEvent(click); });

    expect(click.defaultPrevented).toBe(true);
  });

  it('blocks selectstart and the context menu while dragging', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });

    const selectStart = new Event('selectstart', { bubbles: true, cancelable: true });
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      container.dispatchEvent(selectStart);
      container.dispatchEvent(contextMenu);
    });

    expect(selectStart.defaultPrevented).toBe(true);
    expect(contextMenu.defaultPrevented).toBe(true);
  });

  it('lets clicks through again once the drag is over', async () => {
    const { container } = await renderSplitView();
    await dragPanel(container, 2, 250);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { container.dispatchEvent(click); });

    expect(click.defaultPrevented).toBe(false);
  });

  it('makes panel content inert for the duration of the drag', async () => {
    // Stops hover states and the attachment drag affordances from firing as the
    // pointer sweeps across a transcript.
    const { container } = await renderSplitView();
    const contentWrapper = () =>
      container.querySelector('[data-slot="0"]')!.parentElement as HTMLElement;

    expect(contentWrapper().style.pointerEvents).toBe('');

    await dragPanel(container, 2, 250, { release: false });
    expect(contentWrapper().style.pointerEvents).toBe('none');

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await settle(20);
    expect(contentWrapper().style.pointerEvents).toBe('');
  });

  it('does not leave the document locked if it unmounts mid-drag', async () => {
    // Nothing would be left to undo the lock, leaving the whole side panel
    // unselectable with a grabbing cursor.
    const { container, unmount } = await renderSplitView();
    await dragPanel(container, 2, 250, { release: false });
    expect(document.documentElement.style.userSelect).toBe('none');

    await act(async () => { unmount(); });

    expect(document.documentElement.style.userSelect).toBe('');
    expect(document.documentElement.style.cursor).toBe('');
  });
});

describe('reordering is unavailable when there is nothing to reorder', () => {
  it('does not arm the drag for a lone panel', async () => {
    storedOrder = [0];
    await renderSplitView();

    expect(lastProps.get(0)?.onReorderPointerDown).toBeUndefined();
  });
});

describe('reordering while panels are hidden by width', () => {
  it('keeps the hidden panels in the persisted order', async () => {
    // Only two of three panels fit. Dragging the visible pair must not drop the
    // hidden one from the layout, or widening the window would lose a panel.
    storedOrder = [2, 1, 0];
    stubContainerWidth(800); // room for two
    const { container } = await renderSplitView();
    expect(domSlotOrder(container)).toEqual([0, 1]);

    await dragPanel(container, 1, 300);

    // Slot 1 and slot 0 swap; slot 2 stays hidden at the far left.
    expect(setLayout).toHaveBeenCalledWith({ order: [2, 0, 1] });
  });
});

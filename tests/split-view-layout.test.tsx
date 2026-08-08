// @vitest-environment jsdom
/**
 * The invariants that make reordering panels safe.
 *
 * Reordering must be a purely visual operation. Everything that could interrupt a
 * running conversation is asserted here, because each one is a silent failure —
 * the UI looks right and the stream dies:
 *
 * 1. No panel remounts. A remount runs `useChatStream`'s teardown, which aborts
 *    the in-flight request and discards the input draft.
 * 2. No panel's slot (`panelIndex`) changes. Slots are storage keys, and
 *    `useConversations` re-reads its conversation when its key changes — which
 *    would swap the transcript out from under a stream.
 * 3. No DOM node moves. Chrome resets `scrollTop` on the scrollable descendants
 *    of a moved node, so a reparented panel jumps its transcript to the bottom.
 * 4. Only the position-derived UI (settings / split / close) changes.
 *
 * Closing a panel is covered too, since it shares the same machinery and used to
 * violate 1 and 2 for the *siblings* of the closed panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import type { ChatPanelHandle } from '@/components/chat/ChatPanel';

/** Mount/unmount log per slot, to prove nothing remounts. */
const mounts: number[] = [];
const unmounts: number[] = [];
/** The props each slot was last rendered with. */
const lastProps = new Map<number, Record<string, unknown>>();
/** Every `panelIndex` a given panel element was rendered with, in order. */
const slotHistory = new Map<number, number[]>();

vi.mock('@/components/chat/ChatPanel', () => ({
  ChatPanel: forwardRef<ChatPanelHandle, Record<string, unknown>>(function StubPanel(props, ref) {
    const slot = props.panelIndex as number;
    lastProps.set(slot, { ...props });
    const seen = slotHistory.get(slot) ?? [];
    if (seen[seen.length - 1] !== slot) seen.push(slot);
    slotHistory.set(slot, seen);

    useEffect(() => {
      mounts.push(slot);
      return () => { unmounts.push(slot); };
      // Intentionally keyed on nothing: this must fire exactly once per mount, so
      // a re-render with new props does not look like a remount.
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

    return <div data-testid={`panel-${slot}`} data-slot={slot} />;
  }),
}));

let storedOrder: number[] = [0];
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

/** jsdom has no layout, so SplitView would measure 0 and cap itself at one panel. */
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

beforeEach(() => {
  mounts.length = 0;
  unmounts.length = 0;
  lastProps.clear();
  slotHistory.clear();
  setLayout.mockClear();
  releasePanelSlot.mockClear();
  openPanelSlot.mockClear();
  storedOrder = [2, 1, 0];
  stubContainerWidth(1400); // wide enough for three panels
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

afterEach(() => {
  // Without this, each test leaves its SplitView mounted and the next one's
  // queries match panels from both — which reads as a stray extra panel.
  cleanup();
});

/**
 * Waits for a closed panel to actually leave the DOM.
 *
 * A closed panel stays mounted until its AnimatePresence exit animation
 * finishes, and motion drives that from `requestAnimationFrame`, which jsdom
 * services on its own schedule — a fixed sleep is either flaky or needlessly
 * slow. Polling for the outcome is both.
 */
async function waitForUnmount(slot: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (unmounts.includes(slot)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(
    `panel in slot ${slot} never unmounted (unmounts so far: [${unmounts.join(', ')}])`,
  );
}

async function settle(ms = 60) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function renderSplitView() {
  const { SplitView } = await import('@/components/chat/SplitView');
  const utils = render(<SplitView />);
  await settle();
  return utils;
}

/** The `data-slot` of every rendered panel, in DOM order. */
function domSlotOrder(container: HTMLElement): number[] {
  return [...container.querySelectorAll('[data-slot]')].map((el) =>
    Number(el.getAttribute('data-slot')),
  );
}

/** The CSS `order` of each panel wrapper, keyed by slot. */
function visualOrder(container: HTMLElement): Record<number, number> {
  const out: Record<number, number> = {};
  for (const el of container.querySelectorAll('[data-slot]')) {
    const slot = Number(el.getAttribute('data-slot'));
    // The wrapper motion.div carries the `order`; the stub is two levels down.
    const wrapper = el.parentElement?.parentElement as HTMLElement | null;
    out[slot] = Number(wrapper?.style.order ?? -1);
  }
  return out;
}

describe('SplitView layout invariants', () => {
  it('renders panels in ascending slot order in the DOM, whatever the visual order', async () => {
    // Invariant 3. DOM order must be independent of the visual order, so React
    // never has to move a node.
    storedOrder = [1, 0, 2]; // visual: slot 1 leftmost, slot 2 rightmost
    const { container } = await renderSplitView();

    expect(domSlotOrder(container)).toEqual([0, 1, 2]);
    // ...while CSS order carries the arrangement the user asked for.
    expect(visualOrder(container)).toEqual({ 1: 0, 0: 1, 2: 2 });
  });

  it('gives the rightmost panel Settings and no close button', async () => {
    // Invariant 4, and the answer to "which panel is primary" after a reorder:
    // it follows position, so slot 2 owns Settings here despite the high id.
    storedOrder = [1, 0, 2];
    await renderSplitView();

    expect(lastProps.get(2)).toMatchObject({ showSettings: true, showClose: false });
    expect(lastProps.get(1)).toMatchObject({ showSettings: false, showClose: true });
    expect(lastProps.get(0)).toMatchObject({ showSettings: false, showClose: true });
  });

  it('gives the leftmost panel the split button', async () => {
    storedOrder = [1, 0]; // only two of three allowed panels are open
    await renderSplitView();

    expect(lastProps.get(1)).toMatchObject({ showSplitButton: true });
    expect(lastProps.get(0)).toMatchObject({ showSplitButton: false });
  });

  it('mounts each panel exactly once', async () => {
    await renderSplitView();
    expect([...mounts].sort()).toEqual([0, 1, 2]);
    expect(unmounts).toEqual([]);
  });

  it('keeps every panel on its own slot', async () => {
    // Invariant 2: a panel element must only ever see one `panelIndex`, because
    // that value is its storage key.
    storedOrder = [1, 0, 2];
    await renderSplitView();
    for (const [slot, seen] of slotHistory) {
      expect(seen).toEqual([slot]);
    }
  });
});

describe('closing a panel leaves its siblings alone', () => {
  it('does not remount or re-slot any surviving panel', async () => {
    // The regression that motivated slot/position separation: closing the middle
    // panel used to shift slot 2's storage into slot 1 and force a remount, which
    // aborted that panel's stream.
    await renderSplitView();
    mounts.length = 0;

    const close = lastProps.get(1)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();
    await waitForUnmount(1);

    // Only the closed panel goes away.
    expect(unmounts).toEqual([1]);
    expect(mounts).toEqual([]);
    // Survivors keep their slots, so their storage keys still resolve.
    expect(slotHistory.get(0)).toEqual([0]);
    expect(slotHistory.get(2)).toEqual([2]);
    // Only the closed slot's storage is touched.
    expect(releasePanelSlot).toHaveBeenCalledTimes(1);
    expect(releasePanelSlot.mock.calls[0]?.[1]).toBe(1);
  });

  it('persists the order without the closed slot, leaving the rest in place', async () => {
    await renderSplitView();

    const close = lastProps.get(1)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();

    expect(setLayout).toHaveBeenCalledWith({ order: [2, 0] });
  });

  it('hands Settings to the new rightmost panel when the primary is closed', async () => {
    // Slot 1 has been dragged rightmost, so it is the primary and slot 0 is not.
    storedOrder = [2, 0, 1];
    await renderSplitView();
    expect(lastProps.get(1)).toMatchObject({ showSettings: true, showClose: false });

    const close = lastProps.get(0)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();
    await waitForUnmount(0);

    // Slot 1 is still rightmost, and slot 0 is gone.
    expect(setLayout).toHaveBeenCalledWith({ order: [2, 1] });
    expect(unmounts).toEqual([0]);
  });

  it('refuses to close the last remaining panel', async () => {
    storedOrder = [0];
    await renderSplitView();

    // The only panel is rightmost, so it is not offered a close button at all.
    expect(lastProps.get(0)).toMatchObject({ showClose: false });
    expect(lastProps.get(0)?.onClose).toBeTypeOf('function');

    const close = lastProps.get(0)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();

    expect(unmounts).toEqual([]);
    expect(releasePanelSlot).not.toHaveBeenCalled();
  });
});

describe('splitting', () => {
  it('opens the lowest free slot on the left without disturbing the others', async () => {
    storedOrder = [0];
    await renderSplitView();
    mounts.length = 0;

    const split = lastProps.get(0)?.onSplit as () => void;
    await act(async () => { split(); });
    await settle();

    expect(setLayout).toHaveBeenCalledWith({ order: [1, 0] });
    // The existing panel neither remounts nor changes slot.
    expect(unmounts).toEqual([]);
    expect(slotHistory.get(0)).toEqual([0]);
    // The new slot is blanked, and only the new slot.
    expect(openPanelSlot).toHaveBeenCalledTimes(1);
    expect(openPanelSlot.mock.calls[0]?.[1]).toBe(1);
  });

  it('reuses a slot freed by an earlier close, keeping storage keys dense', async () => {
    storedOrder = [2, 0]; // slot 1 was closed earlier
    await renderSplitView();

    const split = lastProps.get(2)?.onSplit as () => void;
    await act(async () => { split(); });
    await settle();

    expect(setLayout).toHaveBeenCalledWith({ order: [1, 2, 0] });
  });
});

describe('width-driven collapse', () => {
  it('hides panels from the left and keeps the primary', async () => {
    storedOrder = [2, 1, 0];
    // Only wide enough for two panels.
    stubContainerWidth(800);
    const { container } = await renderSplitView();

    expect(domSlotOrder(container)).toEqual([0, 1]);
    // Hiding is a width constraint, not a close: no storage is touched, so the
    // panel resumes the same conversation when the width returns.
    expect(releasePanelSlot).not.toHaveBeenCalled();
    expect(setLayout).not.toHaveBeenCalled();
  });

  it('keeps the visually rightmost panel when the order was changed', async () => {
    // Slot 1 is rightmost, so it must be the survivor — not slot 0.
    storedOrder = [2, 0, 1];
    stubContainerWidth(400); // one panel only
    const { container } = await renderSplitView();

    expect(domSlotOrder(container)).toEqual([1]);
    expect(lastProps.get(1)).toMatchObject({ showSettings: true, showClose: false });
  });
});

describe('session claims', () => {
  it('reports each panel the conversations its visible siblings hold', async () => {
    await renderSplitView();

    const notify = lastProps.get(0)?.onSessionChange as (s: number, id: string | null) => void;
    await act(async () => {
      notify(0, 'conv-a');
      await new Promise((r) => setTimeout(r, 20));
    });

    // Every other visible panel learns the claim; the owner does not see its own.
    expect(lastProps.get(1)?.occupiedSessionIds).toEqual(['conv-a']);
    expect(lastProps.get(2)?.occupiedSessionIds).toEqual(['conv-a']);
    expect(lastProps.get(0)?.occupiedSessionIds).toEqual([]);
  });

  it('drops a closed panel claim so another panel may take the conversation', async () => {
    await renderSplitView();

    const notify = lastProps.get(1)?.onSessionChange as (s: number, id: string | null) => void;
    await act(async () => {
      notify(1, 'conv-b');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(lastProps.get(0)?.occupiedSessionIds).toEqual(['conv-b']);

    const close = lastProps.get(1)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();

    expect(lastProps.get(0)?.occupiedSessionIds).toEqual([]);
  });
});

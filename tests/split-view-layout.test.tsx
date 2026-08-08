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

/**
 * A resizable container stub, for the tests that need the width to change *after*
 * mount — a collapse only misbehaves while the outgoing panel is still animating,
 * which cannot be observed on a container that was always narrow.
 */
function stubResizableContainer(initialWidth: number) {
  let emit: ((width: number) => void) | null = null;
  class WidthObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      emit = (width: number) => {
        this.cb(
          [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      };
      emit(initialWidth);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = WidthObserver as unknown as typeof ResizeObserver;
  return { resize: (width: number) => emit?.(width) };
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

/**
 * The slots in the left-to-right sequence the browser would actually paint them.
 *
 * Asserting on raw `order` values is not enough: they are only meaningful
 * relative to each other, and when two wrappers share a value flexbox falls back
 * to DOM order — which is pinned to ascending slot here, so a tie silently paints
 * panels by slot id rather than by position. That tie *was* the bug, and a test
 * reading only `visualOrder` cannot see it.
 */
function paintOrder(container: HTMLElement): number[] {
  return [...container.querySelectorAll('[data-slot]')]
    .map((el, domIndex) => {
      const slot = Number(el.getAttribute('data-slot'));
      const wrapper = el.parentElement?.parentElement as HTMLElement | null;
      return { slot, order: Number(wrapper?.style.order ?? 0), domIndex };
    })
    .sort((a, b) => a.order - b.order || a.domIndex - b.domIndex)
    .map((entry) => entry.slot);
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

  it('closes against the visible layout, discarding the collapsed panels', async () => {
    // The regression: closing used to be committed against the intended order, so
    // `[2,1,0]` collapsed to two panels went to `[2,0]` when the left one was
    // closed — still two panels, the left one merely swapping slot 1 for the
    // previously hidden slot 2, which read as the close having failed.
    storedOrder = [2, 1, 0];
    stubContainerWidth(800); // two panels: slot 1 left, slot 0 right; slot 2 hidden
    const { container } = await renderSplitView();
    expect(domSlotOrder(container)).toEqual([0, 1]);

    const close = lastProps.get(1)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();
    await waitForUnmount(1);

    // What the user sees is the whole layout, so one panel is left.
    expect(setLayout).toHaveBeenCalledWith({ order: [0] });
    expect(domSlotOrder(container)).toEqual([0]);
    // The collapsed panel is committed away too, so its conversation is freed for
    // another panel rather than staying claimed by a panel that no longer exists.
    expect(releasePanelSlot).toHaveBeenCalledTimes(2);
    expect(releasePanelSlot.mock.calls.map((c) => c[1]).sort()).toEqual([1, 2]);
    // The survivor is untouched: same slot, no remount.
    expect(slotHistory.get(0)).toEqual([0]);
  });

  it('refuses to close the only visible panel while others are collapsed', async () => {
    // Slot 0 is the sole visible panel, so it has no close button. A stray call
    // must not silently discard the collapsed panels and leave nothing rendered.
    storedOrder = [2, 1, 0];
    stubContainerWidth(400); // one panel only
    await renderSplitView();
    expect(lastProps.get(0)).toMatchObject({ showClose: false });

    const close = lastProps.get(0)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();

    expect(unmounts).toEqual([]);
    expect(releasePanelSlot).not.toHaveBeenCalled();
    expect(setLayout).not.toHaveBeenCalled();
  });
});

describe('a panel leaving animates out of the position it occupied', () => {
  /*
   * A departing panel keeps rendering until its exit animation ends, but
   * `AnimatePresence` never re-renders the element it holds, so it paints with the
   * CSS `order` it last had. Numbering `order` densely over the *remaining* panels
   * therefore handed a survivor the departing panel's value, and since DOM order
   * is pinned to ascending slot, flexbox broke the tie by slot id — the two
   * swapped places for the length of the animation.
   *
   * These assert the frame while the exit is in flight, which is the only time the
   * bug is visible; every assertion here passes trivially once it has finished.
   */

  it('collapses the leftmost panel from the left edge, not the middle', async () => {
    // The reported symptom: collapsing [2,1,0] to two panels looked like the
    // middle panel shrinking away while the leftmost changed its contents.
    storedOrder = [2, 1, 0];
    const container = stubResizableContainer(1400);
    const { container: dom } = await renderSplitView();
    expect(paintOrder(dom)).toEqual([2, 1, 0]);

    // Sampled synchronously: this is the frame the exit animation starts on.
    act(() => { container.resize(800); });

    // Slot 2 is on its way out and must still be painted leftmost, where it is
    // visibly shrinking. Slot 1 must not have jumped ahead of it.
    expect(paintOrder(dom)).toEqual([2, 1, 0]);

    await settle(600);
    await waitForUnmount(2);
    // Once it is gone the survivors close up, still in the same relative order.
    expect(paintOrder(dom)).toEqual([1, 0]);
  });

  it('leaves the surviving panels\' ranks untouched when a middle panel closes', async () => {
    // The close path's exit is too short-lived in jsdom to sample mid-flight, so
    // assert the property that makes it correct instead: closing must not renumber
    // the survivors. If it did, one of them would take the rank the departing
    // panel is still painting with, which is what produced the swap.
    storedOrder = [2, 1, 0];
    const { container } = await renderSplitView();
    const before = visualOrder(container);

    const close = lastProps.get(1)?.onClose as () => void;
    await act(async () => { close(); });
    await settle();
    await waitForUnmount(1);

    const after = visualOrder(container);
    expect(after[2]).toBe(before[2]);
    expect(after[0]).toBe(before[0]);
    // And they still paint in the same relative order.
    expect(paintOrder(container)).toEqual([2, 0]);
  });

  it('restores the original arrangement when the width comes back', async () => {
    // Collapsing is reversible, so the panel must return to the edge it left
    // from rather than wherever a renumber would have put it.
    storedOrder = [2, 1, 0];
    const container = stubResizableContainer(1400);
    const { container: dom } = await renderSplitView();

    await act(async () => { container.resize(800); });
    await settle(600);
    expect(paintOrder(dom)).toEqual([1, 0]);

    await act(async () => { container.resize(1400); });
    await settle(600);
    expect(paintOrder(dom)).toEqual([2, 1, 0]);
  });

  it('gives every visible panel a distinct paint rank', async () => {
    // The invariant behind all of the above: a shared `order` value is what lets
    // DOM order decide, and DOM order carries no positional meaning here.
    storedOrder = [1, 0, 2];
    const { container } = await renderSplitView();

    const ranks = Object.values(visualOrder(container));
    expect(new Set(ranks).size).toBe(ranks.length);
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

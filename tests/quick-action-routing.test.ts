import { describe, it, expect } from 'vitest';
import { routeQuickAction, type PanelRoutingState } from '@/lib/quick-action-routing';

/**
 * Terse panel builder: `p(slot, streaming, hasContent, logicalIndex?)`.
 *
 * `logicalIndex` defaults to the slot, which is the layout before anything is
 * reordered — so the unreordered cases read the same as they did when routing was
 * slot-based, and the reorder cases below can state the difference explicitly.
 */
const p = (
  slot: number,
  isStreaming: boolean,
  hasContent: boolean,
  logicalIndex = slot,
): PanelRoutingState => ({ slot, logicalIndex, isStreaming, hasContent });

describe('routeQuickAction', () => {
  it('sends on the only panel when it is idle and empty', () => {
    expect(routeQuickAction([p(0, false, false)], true)).toEqual({
      slot: 0,
      delivery: 'send',
    });
  });

  it('prefills instead of sending when the action carries no prompt', () => {
    // An action with nothing to ask must never fire a request, even on a panel
    // that could accept one.
    expect(routeQuickAction([p(0, false, false)], false)).toEqual({
      slot: 0,
      delivery: 'prefill',
    });
  });

  it('prefers the rightmost sendable panel', () => {
    const route = routeQuickAction([p(1, false, false), p(0, false, false)], true);
    expect(route).toEqual({ slot: 0, delivery: 'send' });
  });

  it('skips a busy panel to send on an idle one', () => {
    const route = routeQuickAction([p(0, true, false), p(1, false, false)], true);
    expect(route).toEqual({ slot: 1, delivery: 'send' });
  });

  it('skips a panel holding a draft to send on an empty one', () => {
    const route = routeQuickAction([p(0, false, true), p(1, false, false)], true);
    expect(route).toEqual({ slot: 1, delivery: 'send' });
  });

  it('prefills the empty panel when every panel is streaming', () => {
    // Nothing can be sent, so the empty input is the courteous landing spot even
    // though that panel is mid-stream.
    const route = routeQuickAction([p(0, true, true), p(1, true, false)], true);
    expect(route).toEqual({ slot: 1, delivery: 'prefill' });
  });

  it('prefills an empty input over an idle panel that holds a draft', () => {
    // Slot 0 is idle but has a draft; slot 1 is streaming but empty. Landing on
    // the empty one avoids merging two texts in one box.
    const route = routeQuickAction([p(0, false, true), p(1, true, false)], true);
    expect(route).toEqual({ slot: 1, delivery: 'prefill' });
  });

  it('falls back to the rightmost panel when every input holds a draft', () => {
    const route = routeQuickAction([p(2, false, true), p(1, true, true), p(0, true, true)], true);
    expect(route).toEqual({ slot: 0, delivery: 'prefill' });
  });

  it('reports no slot when no panels are known, leaving the fallback to the caller', () => {
    // Only the caller knows which panels have actually mounted, so it owns the
    // fallback. It must still not drop the action.
    expect(routeQuickAction([], true)).toEqual({ slot: undefined, delivery: 'prefill' });
  });
});

describe('routeQuickAction follows position, not slot', () => {
  it('prefers the panel the user sees on the right after a reorder', () => {
    // Slot 1 has been dragged to the right, so it is now the primary panel.
    // Routing must follow what the user is looking at: a slot-based policy would
    // wrongly prefer slot 0, which now sits on the left.
    const route = routeQuickAction(
      [
        p(0, false, false, 1), // dragged left
        p(1, false, false, 0), // now rightmost
      ],
      true,
    );
    expect(route).toEqual({ slot: 1, delivery: 'send' });
  });

  it('falls back to the visually rightmost panel when every input holds a draft', () => {
    const route = routeQuickAction(
      [
        p(0, true, true, 2),
        p(2, true, true, 1),
        p(1, true, true, 0), // rightmost despite the low slot id
      ],
      true,
    );
    expect(route).toEqual({ slot: 1, delivery: 'prefill' });
  });

  it('still skips a busy rightmost panel for an idle neighbour', () => {
    const route = routeQuickAction(
      [
        p(2, false, false, 1),
        p(0, true, false, 0), // rightmost but streaming
      ],
      true,
    );
    expect(route).toEqual({ slot: 2, delivery: 'send' });
  });

  it('breaks a logical-index tie deterministically, on slot', () => {
    // Two panels reporting the same index means the layout was mid-update. Any
    // answer is defensible, but it must not vary between renders.
    const route = routeQuickAction(
      [p(2, false, false, 0), p(1, false, false, 0)],
      true,
    );
    expect(route).toEqual({ slot: 1, delivery: 'send' });
  });
});

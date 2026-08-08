import { describe, it, expect } from 'vitest';
import {
  MAX_SLOT_ID,
  addPanel,
  allocateSlot,
  defaultOrder,
  equalRatios,
  isSameOrder,
  leftmostSlot,
  logicalIndexOfSlot,
  movePanel,
  movePanelBySlot,
  normalizeOrder,
  positionOfSlot,
  primarySlot,
  ratiosForOrder,
  removePanel,
  slotAtPosition,
  visualSequence,
  ranksForSequence,
} from '@/lib/panel-order';

describe('default order', () => {
  it('puts slot 0 rightmost, matching the layout before order existed', () => {
    // This is the compatibility contract: a user upgrading from a build that
    // derived position as `count-1-i` must find their panels where they left
    // them, with slot 0 (the legacy unsuffixed storage keys) on the right.
    expect(defaultOrder(1)).toEqual([0]);
    expect(defaultOrder(2)).toEqual([1, 0]);
    expect(defaultOrder(3)).toEqual([2, 1, 0]);
  });
});

describe('slot ↔ position ↔ logical index', () => {
  const order = [2, 0, 1]; // slot 2 leftmost, slot 1 rightmost

  it('maps a slot to its screen position', () => {
    expect(positionOfSlot(order, 2)).toBe(0);
    expect(positionOfSlot(order, 0)).toBe(1);
    expect(positionOfSlot(order, 1)).toBe(2);
  });

  it('maps a slot to its logical index, counting from the right', () => {
    // Logical 0 is the primary panel. After this reorder that is slot 1, *not*
    // slot 0 — which is the whole point of the mapping layer.
    expect(logicalIndexOfSlot(order, 1)).toBe(0);
    expect(logicalIndexOfSlot(order, 0)).toBe(1);
    expect(logicalIndexOfSlot(order, 2)).toBe(2);
  });

  it('reports -1 for a slot that is not open', () => {
    expect(positionOfSlot([0], 1)).toBe(-1);
    expect(logicalIndexOfSlot([0], 1)).toBe(-1);
  });

  it('resolves the slot at a position', () => {
    expect(slotAtPosition(order, 0)).toBe(2);
    expect(slotAtPosition(order, 3)).toBeUndefined();
  });

  it('identifies the primary (rightmost) and leftmost slots', () => {
    expect(primarySlot(order)).toBe(1);
    expect(leftmostSlot(order)).toBe(2);
    expect(primarySlot([])).toBeUndefined();
  });

  it('keeps logical 0 on the rightmost panel for every order', () => {
    // The invariant the UI depends on: Settings and "cannot close" follow
    // logical 0, so it must always resolve to the last entry.
    for (const order of [[0], [1, 0], [0, 1], [2, 1, 0], [1, 0, 2], [0, 2, 1]]) {
      const rightmost = order[order.length - 1]!;
      expect(logicalIndexOfSlot(order, rightmost)).toBe(0);
    }
  });
});

describe('movePanel', () => {
  it('moves a panel left, sliding the others right', () => {
    expect(movePanel([2, 1, 0], 2, 0)).toEqual([0, 2, 1]);
  });

  it('moves a panel right, sliding the others left', () => {
    expect(movePanel([2, 1, 0], 0, 2)).toEqual([1, 0, 2]);
  });

  it('moves a panel by one position', () => {
    expect(movePanel([2, 1, 0], 1, 0)).toEqual([1, 2, 0]);
  });

  it('leaves the order unchanged for a no-op or out-of-range move', () => {
    expect(movePanel([2, 1, 0], 1, 1)).toEqual([2, 1, 0]);
    expect(movePanel([2, 1, 0], 0, 3)).toEqual([2, 1, 0]);
    expect(movePanel([2, 1, 0], 0, -1)).toEqual([2, 1, 0]);
    expect(movePanel([2, 1, 0], 5, 0)).toEqual([2, 1, 0]);
  });

  it('does not mutate its input', () => {
    const order = [2, 1, 0];
    movePanel(order, 0, 2);
    expect(order).toEqual([2, 1, 0]);
  });

  it('preserves the set of slots, so no panel is lost or duplicated', () => {
    // A reorder that dropped a slot would unmount a live panel and abort its
    // stream; one that duplicated a slot would produce duplicate React keys.
    const order = [2, 1, 0];
    for (let from = 0; from < 3; from++) {
      for (let to = 0; to < 3; to++) {
        const next = movePanel(order, from, to);
        expect([...next].sort()).toEqual([0, 1, 2]);
      }
    }
  });
});

describe('movePanelBySlot', () => {
  it('moves the named panel by a delta, for the keyboard path', () => {
    expect(movePanelBySlot([2, 1, 0], 1, -1)).toEqual([1, 2, 0]);
    expect(movePanelBySlot([2, 1, 0], 1, 1)).toEqual([2, 0, 1]);
  });

  it('is a no-op at the ends and for an unknown slot', () => {
    expect(movePanelBySlot([2, 1, 0], 2, -1)).toEqual([2, 1, 0]);
    expect(movePanelBySlot([2, 1, 0], 0, 1)).toEqual([2, 1, 0]);
    expect(movePanelBySlot([1, 0], 2, -1)).toEqual([1, 0]);
  });
});

describe('slot allocation', () => {
  it('reuses the lowest free slot so keys stay dense', () => {
    expect(allocateSlot([0])).toBe(1);
    expect(allocateSlot([1, 0])).toBe(2);
    // Slot 1 was closed; a new panel takes it back rather than moving to 2.
    expect(allocateSlot([2, 0])).toBe(1);
  });

  it('returns undefined when every slot is taken', () => {
    expect(allocateSlot([2, 1, 0])).toBeUndefined();
  });

  it('never allocates beyond MAX_SLOT_ID', () => {
    const slot = allocateSlot([0, 1]);
    expect(slot).toBeLessThanOrEqual(MAX_SLOT_ID);
  });
});

describe('addPanel', () => {
  it('opens the new panel on the far left, where the split button is', () => {
    expect(addPanel([0])).toEqual({ order: [1, 0], slot: 1 });
    expect(addPanel([1, 0])).toEqual({ order: [2, 1, 0], slot: 2 });
  });

  it('opens on the left even after a reorder', () => {
    // Slot 0 has been dragged left; a split must still appear leftmost, and
    // must not disturb where slot 0 sits.
    expect(addPanel([0, 1])).toEqual({ order: [2, 0, 1], slot: 2 });
  });

  it('declines rather than silently doing nothing when full', () => {
    expect(addPanel([2, 1, 0])).toBeNull();
  });
});

describe('removePanel', () => {
  it('removes only the closed slot, leaving siblings in place', () => {
    // The old scheme shifted slot 2's storage down into slot 1 and remounted it,
    // which aborted that panel's stream. Now nothing else moves at all.
    expect(removePanel([2, 1, 0], 1)).toEqual([2, 0]);
  });

  it('keeps the relative order of the remaining panels', () => {
    expect(removePanel([1, 0, 2], 0)).toEqual([1, 2]);
  });

  it('ignores a slot that is not open', () => {
    expect(removePanel([1, 0], 2)).toEqual([1, 0]);
  });

  it('leaves the surviving slots untouched, so their storage keys still resolve', () => {
    const next = removePanel([2, 1, 0], 1);
    expect(next).toContain(2);
    expect(next).toContain(0);
  });
});

describe('isSameOrder', () => {
  it('detects an unchanged order so a no-op drag skips the storage write', () => {
    expect(isSameOrder([2, 1, 0], [2, 1, 0])).toBe(true);
    expect(isSameOrder([2, 1, 0], [2, 0, 1])).toBe(false);
    expect(isSameOrder([1, 0], [1, 0, 2])).toBe(false);
  });
});

describe('normalizeOrder', () => {
  it('passes a well-formed order through', () => {
    expect(normalizeOrder([1, 0, 2])).toEqual([1, 0, 2]);
  });

  it('falls back to a single panel for a missing or malformed value', () => {
    // The primary panel must always exist, so an empty result is not acceptable.
    expect(normalizeOrder(undefined)).toEqual([0]);
    expect(normalizeOrder(null)).toEqual([0]);
    expect(normalizeOrder('nope')).toEqual([0]);
    expect(normalizeOrder([])).toEqual([0]);
    expect(normalizeOrder(['a', {}, null])).toEqual([0]);
  });

  it('drops duplicates, which would produce duplicate React keys', () => {
    expect(normalizeOrder([1, 1, 0])).toEqual([1, 0]);
  });

  it('drops slots outside the allocatable range', () => {
    expect(normalizeOrder([5, 1, -1, 0, 1.5])).toEqual([1, 0]);
  });

  it('trims from the left when maxSplitPanels was lowered', () => {
    // Trimming the leftmost matches how a narrowing side panel collapses, so
    // the panel the user cares about most survives.
    expect(normalizeOrder([2, 1, 0], 2)).toEqual([1, 0]);
    expect(normalizeOrder([2, 1, 0], 1)).toEqual([0]);
  });

  it('respects a reordered layout when trimming', () => {
    expect(normalizeOrder([0, 2, 1], 2)).toEqual([2, 1]);
  });

  it('clamps an out-of-range bound instead of returning nothing', () => {
    expect(normalizeOrder([2, 1, 0], 0)).toEqual([0]);
    expect(normalizeOrder([2, 1, 0], 99)).toEqual([2, 1, 0]);
  });
});

describe('ratiosForOrder', () => {
  it('keeps each panel its width when the order changes', () => {
    // Widths travel with the panel, not the position: a dropped panel that
    // suddenly changed width is the flash a reorder must not produce.
    const ratios = { 0: 0.5, 1: 0.3, 2: 0.2 };
    expect(ratiosForOrder(ratios, [1, 0, 2])).toEqual({ 0: 0.5, 1: 0.3, 2: 0.2 });
  });

  it('renormalises to sum 1 after a panel is removed', () => {
    const next = ratiosForOrder({ 0: 0.5, 1: 0.3, 2: 0.2 }, [0, 1]);
    const total = Object.values(next).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    // The surviving panels keep their proportions relative to each other.
    expect(next[0]! / next[1]!).toBeCloseTo(0.5 / 0.3);
  });

  it('gives a newly opened slot an equal share and renormalises', () => {
    const next = ratiosForOrder({ 0: 1 }, [1, 0]);
    const total = Object.values(next).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(Object.keys(next).sort()).toEqual(['0', '1']);
  });

  it('replaces a missing or non-positive ratio with a fallback', () => {
    const next = ratiosForOrder({ 0: 0 }, [0, 1]);
    expect(next[0]).toBeGreaterThan(0);
    expect(next[1]).toBeGreaterThan(0);
  });

  it('only ever contains the open slots', () => {
    const next = ratiosForOrder({ 0: 0.5, 1: 0.5 }, [0]);
    expect(Object.keys(next)).toEqual(['0']);
  });
});

describe('equalRatios', () => {
  it('splits the width evenly across the open slots', () => {
    expect(equalRatios([1, 0])).toEqual({ 0: 0.5, 1: 0.5 });
    const thirds = equalRatios([2, 1, 0]);
    expect(thirds[0]).toBeCloseTo(1 / 3);
    expect(Object.keys(thirds).sort()).toEqual(['0', '1', '2']);
  });
});

describe('visual sequence', () => {
  /** Where flexbox actually paints things: by `order`, ties broken by DOM order. */
  function paint(sequence: readonly number[], onScreen: readonly number[]): number[] {
    const ranks = ranksForSequence(sequence);
    // DOM order is fixed to ascending slot, which is what makes a tie dangerous.
    return [...onScreen]
      .sort((a, b) => a - b)
      .map((slot) => ({ slot, rank: ranks.get(slot) ?? slot }))
      .sort((a, b) => a.rank - b.rank || a.slot - b.slot)
      .map((entry) => entry.slot);
  }

  it('numbers a fresh layout left to right', () => {
    const sequence = visualSequence([2, 1, 0], []);
    expect(paint(sequence, [2, 1, 0])).toEqual([2, 1, 0]);
  });

  it('keeps a collapsing panel painted where it was', () => {
    // The regression. Slot 2 is leftmost and collapsing; it stays rendered while
    // its exit animation runs, holding the rank it last painted with. Renumbering
    // the survivors densely used to give slot 1 that same rank, and the fixed
    // ascending-slot DOM order then painted slot 1 first — so the *middle* panel
    // appeared to shrink away while the leftmost swapped its contents.
    const before = visualSequence([2, 1, 0], []);
    const after = visualSequence([1, 0], before);

    // Mid-exit: slot 2 is still on screen and still leftmost.
    expect(paint(after, [2, 1, 0])).toEqual([2, 1, 0]);
    // And the survivors have not moved under it.
    expect(paint(after, [1, 0])).toEqual([1, 0]);
  });

  it('keeps a closing middle panel painted in the middle', () => {
    const before = visualSequence([2, 1, 0], []);
    const after = visualSequence([2, 0], before);

    expect(paint(after, [2, 1, 0])).toEqual([2, 1, 0]);
    expect(paint(after, [2, 0])).toEqual([2, 0]);
  });

  it('restores the original arrangement when width returns', () => {
    const wide = visualSequence([2, 1, 0], []);
    const narrow = visualSequence([1, 0], wide);
    const rewidened = visualSequence([2, 1, 0], narrow);
    expect(paint(rewidened, [2, 1, 0])).toEqual([2, 1, 0]);
  });

  it('renumbers on a real reorder', () => {
    const before = visualSequence([2, 1, 0], []);
    const after = visualSequence([1, 2, 0], before);
    expect(paint(after, [1, 2, 0])).toEqual([1, 2, 0]);
  });

  it('places a newly split panel on the left', () => {
    const single = visualSequence([0], []);
    const split = visualSequence([1, 0], single);
    expect(paint(split, [1, 0])).toEqual([1, 0]);
  });

  it('is idempotent, so a re-render cannot shift a panel', () => {
    // Called on every render, so an unstable result would move panels for free.
    const first = visualSequence([2, 1, 0], []);
    const second = visualSequence([2, 1, 0], first);
    expect(second).toEqual(first);
  });
});

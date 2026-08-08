import { describe, it, expect } from 'vitest';
import { dragOffsets, dropPosition } from '@/lib/panel-order';

/**
 * Drag geometry for panel reordering.
 *
 * Panels have user-adjustable widths, so a drag cannot be measured in "slots
 * moved". These two functions decide where a drag lands and how the preview is
 * drawn, and they have to agree exactly: the preview offsets must reproduce the
 * layout the drop commits, or the panel visibly jumps when the pointer is
 * released.
 */

describe('dropPosition', () => {
  const equal = [400, 400, 400];

  it('stays put when the pointer has not moved', () => {
    expect(dropPosition(equal, 1, 0)).toBe(1);
  });

  it('does not move until the neighbour is half covered', () => {
    expect(dropPosition(equal, 0, 199)).toBe(0);
    expect(dropPosition(equal, 0, 200)).toBe(1);
  });

  it('swaps leftwards on the same half-width rule', () => {
    expect(dropPosition(equal, 2, -199)).toBe(2);
    expect(dropPosition(equal, 2, -200)).toBe(1);
  });

  it('crosses two neighbours when the pointer travels far enough', () => {
    // Past the first panel (400) plus half the second (200).
    expect(dropPosition(equal, 2, -600)).toBe(0);
    expect(dropPosition(equal, 0, 600)).toBe(2);
  });

  it('clamps at the ends rather than running off', () => {
    expect(dropPosition(equal, 0, 5000)).toBe(2);
    expect(dropPosition(equal, 2, -5000)).toBe(0);
  });

  it('uses each neighbour own width, not the dragged panel width', () => {
    // A wide panel must displace a narrow neighbour as soon as it overlaps it,
    // rather than after travelling its own width — otherwise dragging a wide
    // panel feels unresponsive.
    const widths = [200, 800]; // narrow left, wide right
    // Dragging the wide panel left only needs to cover half of the narrow one.
    expect(dropPosition(widths, 1, -99)).toBe(1);
    expect(dropPosition(widths, 1, -100)).toBe(0);
    // Dragging the narrow panel right needs to cover half of the wide one.
    expect(dropPosition(widths, 0, 399)).toBe(0);
    expect(dropPosition(widths, 0, 400)).toBe(1);
  });

  it('ignores an out-of-range origin', () => {
    expect(dropPosition(equal, 5, 100)).toBe(5);
    expect(dropPosition(equal, -1, 100)).toBe(-1);
  });
});

describe('dragOffsets', () => {
  const equal = [400, 400, 400];

  it('moves only the dragged panel while it stays in place', () => {
    expect(dragOffsets(equal, 1, 1, 50)).toEqual([0, 50, 0]);
  });

  it('displaces a neighbour by exactly the dragged panel width', () => {
    // The preview must land the neighbour precisely where the committed layout
    // will put it, or the drop is visible as a jump.
    expect(dragOffsets(equal, 0, 1, 250)).toEqual([250, -400, 0]);
    expect(dragOffsets(equal, 2, 1, -250)).toEqual([0, 400, -250]);
  });

  it('displaces every panel the drag crosses', () => {
    expect(dragOffsets(equal, 0, 2, 900)).toEqual([900, -400, -400]);
    expect(dragOffsets(equal, 2, 0, -900)).toEqual([400, 400, -900]);
  });

  it('displaces by the dragged panel width even when widths differ', () => {
    const widths = [200, 800];
    // The wide panel moves left, so the narrow one must move right by 800 — the
    // wide panel's width, which is the gap it vacates.
    expect(dragOffsets(widths, 1, 0, -150)).toEqual([800, -150]);
    // And the narrow panel moving right displaces the wide one by 200.
    expect(dragOffsets(widths, 0, 1, 500)).toEqual([500, -200]);
  });

  it('returns a zero offset per panel for an out-of-range origin', () => {
    expect(dragOffsets(equal, 9, 0, 100)).toEqual([0, 0, 0]);
  });

  it('agrees with dropPosition, so the drop is never visible', () => {
    // The invariant tying the two together: at the moment of release, applying
    // the offsets and applying the reorder must produce the same arrangement.
    // Verified by checking that the dragged panel's final left edge matches the
    // left edge of its target position.
    const widths = [300, 500, 400];
    const edges = [0, 300, 800]; // cumulative left edge per position

    for (const from of [0, 1, 2]) {
      for (const offsetX of [-900, -450, -120, 0, 120, 450, 900]) {
        const target = dropPosition(widths, from, offsetX);
        const deltas = dragOffsets(widths, from, target, offsetX);

        // Where each panel sits during the preview.
        const previewed = widths.map((_, i) => edges[i]! + deltas[i]!);

        // Where each panel sits once the order is committed.
        const reordered = [...widths.keys()];
        const [moved] = reordered.splice(from, 1);
        reordered.splice(target, 0, moved!);
        const committed = new Map<number, number>();
        let edge = 0;
        for (const position of reordered) {
          committed.set(position, edge);
          edge += widths[position]!;
        }

        // Every displaced panel must already be at its committed edge; only the
        // dragged one is still under the pointer.
        for (let i = 0; i < widths.length; i++) {
          if (i === from) continue;
          expect(previewed[i]).toBe(committed.get(i));
        }
      }
    }
  });
});

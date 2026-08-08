/**
 * The compatibility layer between a panel's *storage slot* and its *screen
 * position*.
 *
 * Split view juggles three distinct id spaces, and conflating them is what made
 * reordering panels impossible before:
 *
 * - **slot** — the suffix on a panel's storage keys (`selectedModel_1`, see
 *   `panel-storage.ts`). This is the panel's identity. It is assigned when the
 *   panel opens and never changes while it is mounted, because every per-panel
 *   hook keys its state off it: changing it re-runs `useConversations`' restore
 *   effect, which would swap the panel's conversation out from under an
 *   in-flight stream.
 * - **position** — where the panel sits on screen, left to right. This is what a
 *   drag changes, and it is expressed *only* by the order of `PanelLayout.order`.
 *   Nothing on disk moves.
 * - **logical index** — "how many panels from the right", i.e. `N-1-position`.
 *   This is the UI-facing numbering: logical 0 is the primary panel, which owns
 *   the Settings button and can never be closed. Quick-action routing prefers
 *   low logical indices.
 *
 * So `order` is a live mapping rather than a migration. "Panel 0 is always
 * rightmost" holds because logical index is *derived* from position, not because
 * data was shuffled between slots — which is why a reorder cannot disturb a
 * running stream.
 *
 * Slots are deliberately allowed to be non-contiguous: closing the panel in slot
 * 1 out of `{0,1,2}` leaves `{0,2}` and touches no other panel's storage. The
 * old scheme shifted slot 2's data down into slot 1, which forced a remount and
 * aborted that panel's stream.
 */

/**
 * Highest slot id that may ever be allocated.
 *
 * Bounded by `UISettings.maxSplitPanels`, whose maximum is 3 (slots 0–2).
 * Mirrored by `MAX_PANEL_ID` in `panel-storage.ts`, which prunes the same range.
 */
export const MAX_SLOT_ID = 2;

/**
 * Panel layout as persisted.
 *
 * `order` is the single source of truth for both which panels exist and where
 * they sit, so a count is not stored separately — two fields that must agree are
 * two fields that can disagree.
 */
export interface PanelLayout {
  /** Slot ids, left to right. `order[0]` is the leftmost panel. */
  order: number[];
}

/** The layout a fresh install starts from: one panel, in slot 0. */
export const DEFAULT_PANEL_LAYOUT: PanelLayout = { order: [0] };

/**
 * The order `count` panels take when nothing has been reordered: slot 0
 * rightmost, descending leftward (`3 → [2,1,0]`).
 *
 * Matches the mapping split view hardcoded before order existed, so a layout
 * restored from a build that predates this module lands on the same arrangement
 * the user left.
 */
export function defaultOrder(count: number): number[] {
  return Array.from({ length: count }, (_, i) => count - 1 - i);
}

/** Screen position of `slot`, or -1 if it is not open. */
export function positionOfSlot(order: readonly number[], slot: number): number {
  return order.indexOf(slot);
}

/**
 * Logical index of `slot` — 0 is the rightmost (primary) panel.
 *
 * Returns -1 for a slot that is not open, matching `positionOfSlot`, so callers
 * can test one value.
 */
export function logicalIndexOfSlot(order: readonly number[], slot: number): number {
  const position = positionOfSlot(order, slot);
  return position < 0 ? -1 : order.length - 1 - position;
}

/** The slot at `position`, or `undefined` when out of range. */
export function slotAtPosition(
  order: readonly number[],
  position: number,
): number | undefined {
  return order[position];
}

/** The rightmost (primary) slot. It owns Settings and cannot be closed. */
export function primarySlot(order: readonly number[]): number | undefined {
  return order[order.length - 1];
}

/** The leftmost slot. It owns the split button. */
export function leftmostSlot(order: readonly number[]): number | undefined {
  return order[0];
}

/**
 * Moves the panel at position `from` to position `to`, sliding the panels in
 * between over by one.
 *
 * Out-of-range targets return the input unchanged rather than clamping, for the
 * same reason as `options/models/reorder.ts`: the callers are bounded
 * affordances (a drag that cannot leave the container, arrow keys disabled at the
 * ends), so a clamp would make a no-op look like it worked.
 */
export function movePanel(order: readonly number[], from: number, to: number): number[] {
  if (from < 0 || from >= order.length) return [...order];
  if (to < 0 || to >= order.length || to === from) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Moves the panel in `slot` by `delta` positions (negative is leftward). */
export function movePanelBySlot(
  order: readonly number[],
  slot: number,
  delta: number,
): number[] {
  const from = positionOfSlot(order, slot);
  if (from < 0) return [...order];
  return movePanel(order, from, from + delta);
}

/**
 * Lowest slot id not currently in use.
 *
 * Reusing the lowest free id keeps storage keys dense, so a user who repeatedly
 * splits and closes does not accumulate settings under slots they will never see
 * again. Returns `undefined` when every slot is taken.
 */
export function allocateSlot(order: readonly number[]): number | undefined {
  for (let slot = 0; slot <= MAX_SLOT_ID; slot++) {
    if (!order.includes(slot)) return slot;
  }
  return undefined;
}

/**
 * Inserts a newly opened panel at the far left, where the split button sits.
 *
 * Returns `null` if no slot is free, so the caller can decline the split rather
 * than silently doing nothing.
 */
export function addPanel(order: readonly number[]): { order: number[]; slot: number } | null {
  const slot = allocateSlot(order);
  if (slot === undefined) return null;
  return { order: [slot, ...order], slot };
}

/**
 * Removes `slot` from the layout.
 *
 * Only this slot's entry disappears; every other panel keeps both its slot and
 * its relative position, so no sibling is remounted and no sibling's stream is
 * interrupted.
 */
export function removePanel(order: readonly number[], slot: number): number[] {
  return order.filter((id) => id !== slot);
}

/**
 * Whether two orders are identical.
 *
 * Used to skip a storage write when a drag ends where it started — dropping a
 * panel back in place should not churn `chrome.storage` and wake every other
 * context through a change event.
 */
export function isSameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((slot, i) => slot === b[i]);
}

/**
 * Repairs an order read from storage.
 *
 * Everything here is defence against a value this build did not write: a config
 * exported by a newer build, a downgraded `maxSplitPanels`, or a partial write.
 * A malformed order would otherwise surface as duplicate React keys or a panel
 * rendering at a position that does not exist.
 *
 * Duplicates and out-of-range slots are dropped; an order that ends up empty
 * falls back to the default rather than rendering zero panels, since the primary
 * panel must always exist.
 *
 * @param maxPanels Upper bound from `UISettings.maxSplitPanels`. Excess panels
 *   are trimmed from the left, matching how a width-driven collapse hides them.
 */
export function normalizeOrder(raw: unknown, maxPanels = MAX_SLOT_ID + 1): number[] {
  const bound = Math.max(1, Math.min(maxPanels, MAX_SLOT_ID + 1));
  if (!Array.isArray(raw)) return defaultOrder(1);

  const seen = new Set<number>();
  const cleaned: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    if (value < 0 || value > MAX_SLOT_ID) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value);
  }

  if (cleaned.length === 0) return defaultOrder(1);
  // Trim from the left: the leftmost panel is the one a narrowing side panel
  // hides first, so it is the one the user is least attached to.
  return cleaned.slice(Math.max(0, cleaned.length - bound));
}

/**
 * Reorders `ratios` (keyed by slot) after the order changed, preserving each
 * panel's width.
 *
 * Widths must travel with the panel rather than with the position, or a dragged
 * panel would visibly snap to a new width the instant it is dropped — which is
 * exactly the flash a reorder must not produce.
 */
export function ratiosForOrder(
  ratios: Readonly<Record<number, number>>,
  order: readonly number[],
): Record<number, number> {
  const fallback = 1 / order.length;
  const next: Record<number, number> = {};
  let total = 0;
  for (const slot of order) {
    const ratio = ratios[slot];
    const value = typeof ratio === 'number' && ratio > 0 ? ratio : fallback;
    next[slot] = value;
    total += value;
  }
  // Renormalise so the ratios always sum to 1: slots that were absent
  // contributed a fallback share, and a dropped panel left its share behind.
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    for (const slot of order) next[slot] = next[slot]! / total;
  }
  return next;
}

/** Equal-width ratios for every slot in `order`. */
export function equalRatios(order: readonly number[]): Record<number, number> {
  const share = 1 / order.length;
  const next: Record<number, number> = {};
  for (const slot of order) next[slot] = share;
  return next;
}

/**
 * Which position a panel dragged by `offsetX` should land on.
 *
 * Panels have unequal widths, so "how many slots has it moved" cannot be derived
 * from the offset alone. This walks the neighbours the drag is heading towards
 * and swaps past each one whose midpoint the dragged panel's leading edge has
 * cleared — the standard sortable rule, and the one that makes a wide panel
 * displace a narrow neighbour as soon as it visibly overlaps it, rather than
 * after travelling its own full width.
 *
 * @param widths Outer width of each panel, indexed by position (left to right).
 * @param from The dragged panel's current position.
 * @param offsetX Pointer delta since the drag started, in pixels.
 */
export function dropPosition(
  widths: readonly number[],
  from: number,
  offsetX: number,
): number {
  if (from < 0 || from >= widths.length) return from;

  let target = from;
  if (offsetX > 0) {
    // Moving right: swap past each following panel once the dragged panel has
    // covered half of it.
    let travelled = 0;
    for (let i = from + 1; i < widths.length; i++) {
      travelled += widths[i] ?? 0;
      if (offsetX < travelled - (widths[i] ?? 0) / 2) break;
      target = i;
    }
  } else if (offsetX < 0) {
    let travelled = 0;
    for (let i = from - 1; i >= 0; i--) {
      travelled += widths[i] ?? 0;
      if (-offsetX < travelled - (widths[i] ?? 0) / 2) break;
      target = i;
    }
  }
  return target;
}

/**
 * How far each panel must be shifted, in pixels, to preview a drag in progress.
 *
 * Returned per position rather than applied directly so the caller can write the
 * values into motion values and bypass React entirely: re-rendering the panel
 * tree on every pointer frame would reconcile every transcript and drop frames.
 *
 * The dragged panel follows the pointer; the panels it displaces move by exactly
 * its width, in the opposite direction, so the preview is pixel-identical to the
 * layout that the drop commits. That is what makes the hand-off invisible.
 *
 * @param widths Outer width of each panel, indexed by position.
 * @param from The dragged panel's current position.
 * @param target The position it would drop on.
 * @param offsetX Pointer delta since the drag started, in pixels.
 */
export function dragOffsets(
  widths: readonly number[],
  from: number,
  target: number,
  offsetX: number,
): number[] {
  const offsets = widths.map(() => 0);
  if (from < 0 || from >= widths.length) return offsets;

  offsets[from] = offsetX;
  const draggedWidth = widths[from] ?? 0;
  if (target > from) {
    for (let i = from + 1; i <= target; i++) offsets[i] = -draggedWidth;
  } else if (target < from) {
    for (let i = target; i < from; i++) offsets[i] = draggedWidth;
  }
  return offsets;
}

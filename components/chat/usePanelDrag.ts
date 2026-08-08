import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMotionValue, type MotionValue } from 'motion/react';
import { dragOffsets, dropPosition } from '@/lib/panel-order';

/**
 * Pointer distance the drag must cover before it engages, in pixels.
 *
 * The drag handle is the panel header, which also holds buttons and a model
 * picker. Without a threshold, the tiny pointer movement inside an ordinary click
 * would start a drag and swallow the click.
 */
const DRAG_THRESHOLD_PX = 4;

/** One motion value per slot, holding its live horizontal offset. */
export type PanelOffsets = ReadonlyMap<number, MotionValue<number>>;

/**
 * Suppresses text selection and forces the grabbing cursor document-wide.
 *
 * Applied to `<html>` rather than to the panels: the pointer sweeps across
 * sibling panels and the gaps between them during a drag, and a selection that
 * starts in any of them is just as wrong. Returns the undo function so the caller
 * cannot forget to restore the original values.
 */
function lockDocumentForDrag(): () => void {
  const root = document.documentElement;
  const previousUserSelect = root.style.userSelect;
  const previousWebkitUserSelect = root.style.webkitUserSelect;
  const previousCursor = root.style.cursor;

  root.style.userSelect = 'none';
  root.style.webkitUserSelect = 'none';
  root.style.cursor = 'grabbing';

  return () => {
    root.style.userSelect = previousUserSelect;
    root.style.webkitUserSelect = previousWebkitUserSelect;
    root.style.cursor = previousCursor;
  };
}

export interface UsePanelDragOptions {
  /** Slots left to right, i.e. the current visual order. */
  order: readonly number[];
  /** Outer width of each panel, keyed by slot. Used to decide drop targets. */
  widthBySlot: ReadonlyMap<number, number>;
  /** Commits a completed drag. Only called when the order actually changed. */
  onReorder: (order: number[]) => void;
  /** When false, drags do not start — e.g. a single panel has nothing to reorder. */
  enabled: boolean;
}

export interface UsePanelDragResult {
  /**
   * Live horizontal offset per slot, for the caller to bind to `style.x`.
   *
   * Motion values, not state, so a pointer move writes straight to the
   * compositor without re-rendering the panel tree.
   */
  offsets: PanelOffsets;
  /** The slot being dragged, or null. Only for styling the lifted panel. */
  draggingSlot: number | null;
  /**
   * Whether a drag has engaged, i.e. passed the movement threshold.
   *
   * Distinct from `draggingSlot !== null` only in intent: callers use this to
   * make panel content inert, which must apply to *every* panel, not just the
   * one under the pointer.
   */
  isDragging: boolean;
  /** Starts a drag from a pointer event on a panel's header. */
  startDrag: (slot: number, event: React.PointerEvent) => void;
}


/**
 * Drag-to-reorder for split view panels.
 *
 * ## Why not motion's `Reorder`
 *
 * `Reorder.Item` animates through layout projection, which applies a scale
 * correction to the whole subtree while measuring. A chat panel renders
 * `streamdown` markdown and Shiki-highlighted code, so that correction visibly
 * distorts the text mid-drag — a flash in itself. It also fights the `animate`
 * width that drives panel sizing, and the `ResizeObserver` above it. A pointer
 * handler writing motion values sidesteps all three.
 *
 * ## Why motion values rather than state
 *
 * The offsets are deliberately kept out of React. `ChatPanel` re-renders its
 * whole transcript, so a `setState` per pointer frame would reconcile every
 * message and drop frames on a long conversation. Writing a motion value
 * mutates one transform and never re-renders.
 *
 * ## Why the drop is invisible
 *
 * While dragging, displaced panels are offset by exactly the dragged panel's
 * width, so the preview is pixel-identical to the committed layout. On release,
 * the new order and the reset of every offset are applied in the same batch, so
 * the browser paints one frame in which the transform disappears and the CSS
 * `order` takes over — with nothing moving. Panels keep their slot, their React
 * key and their DOM node throughout, so nothing remounts and no stream is
 * interrupted.
 */
export function usePanelDrag({
  order,
  widthBySlot,
  onReorder,
  enabled,
}: UsePanelDragOptions): UsePanelDragResult {
  const [draggingSlot, setDraggingSlot] = useState<number | null>(null);

  /**
   * A motion value per slot, allocated once for the hook's lifetime.
   *
   * Fixed at `MAX_SLOT_ID + 1` entries and never rebuilt: hooks cannot be called
   * conditionally, and a value recreated when the order changes would lose the
   * offset mid-drag.
   */
  const x0 = useMotionValue(0);
  const x1 = useMotionValue(0);
  const x2 = useMotionValue(0);
  const offsets = useMemo<PanelOffsets>(
    () => new Map([[0, x0], [1, x1], [2, x2]]),
    [x0, x1, x2],
  );

  /**
   * Everything the active drag needs, in a ref.
   *
   * The pointer listeners are attached once per drag and must see live values
   * without being torn down and re-attached — re-subscribing mid-drag drops
   * events, and the browser would not deliver the `pointerup` to the new listener.
   */
  const dragRef = useRef<{
    slot: number;
    from: number;
    startX: number;
    /** Widths by position, snapshotted so a resize mid-drag cannot shift targets. */
    widths: number[];
    order: number[];
    engaged: boolean;
    target: number;
    /** Undoes the document-wide selection/cursor lock. Set once engaged. */
    unlock: (() => void) | null;
  } | null>(null);

  /** Latest inputs, so `startDrag` can stay identity-stable. */
  const latestRef = useRef({ order, widthBySlot, onReorder, enabled });
  latestRef.current = { order, widthBySlot, onReorder, enabled };

  const resetOffsets = useCallback(() => {
    for (const value of offsets.values()) value.set(0);
  }, [offsets]);

  const applyPreview = useCallback(
    (drag: NonNullable<typeof dragRef.current>, offsetX: number) => {
      const target = dropPosition(drag.widths, drag.from, offsetX);
      drag.target = target;
      const deltas = dragOffsets(drag.widths, drag.from, target, offsetX);
      drag.order.forEach((slot, position) => {
        offsets.get(slot)?.set(deltas[position] ?? 0);
      });
    },
    [offsets],
  );

  const startDrag = useCallback((slot: number, event: React.PointerEvent) => {
    const { order: currentOrder, widthBySlot: widths, enabled: isEnabled } = latestRef.current;
    if (!isEnabled || currentOrder.length < 2) return;
    // Primary button / single touch only: a middle-click or a second finger
    // starting a drag would be surprising and hard to cancel.
    if (event.button !== 0) return;

    const from = currentOrder.indexOf(slot);
    if (from < 0) return;

    // Cancels the browser's native selection drag before it begins. Doing this in
    // `pointermove` is too late: the selection has already been seeded by then, so
    // sweeping the pointer down and across highlights the transcripts it passes
    // over. `preventDefault` here also suppresses the focus shift that would
    // otherwise steal focus from whatever the user was typing in.
    event.preventDefault();

    // Any selection made *before* the drag started would still be painted, and
    // would extend as the pointer moves, so clear it up front.
    document.getSelection()?.removeAllRanges();

    dragRef.current = {
      slot,
      from,
      startX: event.clientX,
      widths: currentOrder.map((id) => widths.get(id) ?? 0),
      order: [...currentOrder],
      // Not engaged until the threshold is crossed, so a plain click on the
      // header still behaves like a click.
      engaged: false,
      target: from,
      unlock: null,
    };
  }, []);


  // Pointer listeners live on the document for the duration of a drag: the
  // pointer regularly leaves the header it started on, and `pointerup` must be
  // caught wherever it happens or the panel would stay stuck to the cursor.
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const offsetX = event.clientX - drag.startX;
      if (!drag.engaged) {
        if (Math.abs(offsetX) < DRAG_THRESHOLD_PX) return;
        drag.engaged = true;
        drag.unlock = lockDocumentForDrag();
        setDraggingSlot(drag.slot);
      }
      // Belt and braces alongside the `pointerdown` prevention: a selection can
      // also be extended by a move that the browser began tracking elsewhere.
      event.preventDefault();
      applyPreview(drag, offsetX);
    };

    const finish = (cancelled: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;

      drag.unlock?.();
      if (!drag.engaged) return; // Never crossed the threshold: it was a click.
      setDraggingSlot(null);

      if (cancelled || drag.target === drag.from) {
        resetOffsets();
        return;
      }

      const next = [...drag.order];
      const [moved] = next.splice(drag.from, 1);
      next.splice(drag.target, 0, moved!);

      // Order and offsets in the same batch. React 18+ batches these into one
      // commit, so the frame that adopts the new CSS `order` is the same frame
      // that drops the transform — the panel does not move at all.
      resetOffsets();
      latestRef.current.onReorder(next);
    };

    const handleUp = () => finish(false);
    const handleCancel = () => finish(true);
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape must abandon the drag, the conventional escape hatch for a
      // gesture the user did not mean to start.
      if (event.key === 'Escape' && dragRef.current) finish(true);
    };

    /**
     * Swallows the interactions a drag would otherwise leave behind.
     *
     * `click` is the important one: releasing over a button in another panel
     * would activate it, so a reorder could silently delete a conversation. The
     * listeners are capturing and only fire while a drag is engaged, so ordinary
     * clicks are untouched.
     */
    const suppressWhileDragging = (event: Event) => {
      if (!dragRef.current?.engaged) return;
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleCancel);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', suppressWhileDragging, true);
    document.addEventListener('selectstart', suppressWhileDragging, true);
    // A drag that ends on a right-click would leave the menu over a moving panel.
    document.addEventListener('contextmenu', suppressWhileDragging, true);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleCancel);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('click', suppressWhileDragging, true);
      document.removeEventListener('selectstart', suppressWhileDragging, true);
      document.removeEventListener('contextmenu', suppressWhileDragging, true);
    };
  }, [applyPreview, resetOffsets]);

  // A layout change from anywhere else (a split, a close, a width collapse)
  // invalidates an in-flight drag: its snapshotted widths and positions no
  // longer describe what is on screen.
  useEffect(() => {
    if (!dragRef.current) return;
    dragRef.current.unlock?.();
    dragRef.current = null;
    setDraggingSlot(null);
    resetOffsets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.length, resetOffsets]);

  // Releasing the lock is not optional: an unmount mid-drag would otherwise leave
  // the whole document unselectable with a grabbing cursor, with nothing left to
  // undo it.
  useEffect(() => {
    return () => { dragRef.current?.unlock?.(); };
  }, []);

  return { offsets, draggingSlot, isDragging: draggingSlot !== null, startDrag };
}

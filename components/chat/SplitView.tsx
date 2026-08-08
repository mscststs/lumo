import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChatPanel, type ChatPanelHandle } from '@/components/chat/ChatPanel';
import { useStorageWatch } from '@/store/useStorageWatch';
import { useContextMenuPending } from '@/store/useContextMenuPending';
import { storage } from '@/store/storage';
import { openPanelSlot, releasePanelSlot } from '@/lib/panel-storage';
import {
  addPanel,
  equalRatios,
  isSameOrder,
  normalizeOrder,
  ratiosForOrder,
  removePanel,
} from '@/lib/panel-order';
import { routeQuickAction, type PanelRoutingState } from '@/lib/quick-action-routing';
import { usePanelDrag } from '@/components/chat/usePanelDrag';
import type { UISettings } from '@/types';

/** Minimum width for each panel in pixels */
const MIN_PANEL_WIDTH = 360;
/** Width threshold to allow 2 panels */
const THRESHOLD_2_PANELS = 750;
/** Width threshold to allow 3 panels */
const THRESHOLD_3_PANELS = 1150;
/** Width of the draggable divider between two panels, in pixels */
const DIVIDER_WIDTH = 8;

/** Duration for panel width transitions (ms) */
const TRANSITION_DURATION_MS = 300;

function computeMaxPanels(containerWidth: number, userMax: 1 | 2 | 3): number {
  let allowed = 1;
  if (containerWidth >= THRESHOLD_3_PANELS) {
    allowed = 3;
  } else if (containerWidth >= THRESHOLD_2_PANELS) {
    allowed = 2;
  }
  return Math.min(allowed, userMax);
}

/**
 * SplitView manages multiple ChatPanels side by side with draggable dividers.
 *
 * ## Slots, positions and logical indices
 *
 * A panel's identity is its **slot** — the suffix on its storage keys (see
 * `panel-storage.ts`). A slot is assigned when the panel opens and never changes
 * while it is mounted, because every per-panel hook keys its state off it:
 * changing a live panel's slot would re-run `useConversations`' restore effect
 * and swap its conversation out from under an in-flight stream.
 *
 * Where a panel sits on screen is therefore tracked separately, as `order` — the
 * slots from left to right (see `panel-order.ts`). Reordering rewrites only that
 * array, so it cannot disturb storage, remount a panel, or interrupt a stream.
 *
 * The UI-facing numbering is the **logical index**, `N-1-position`: logical 0 is
 * the rightmost (primary) panel, which owns the Settings button and cannot be
 * closed. Because it is derived from position rather than from the slot id, the
 * invariant "panel 0 is on the right" survives any reordering for free.
 *
 * Slots are deliberately allowed to be sparse. Closing the panel in slot 1 out of
 * `{0,1,2}` leaves `{0,2}`; an earlier version instead shifted slot 2's storage
 * down into slot 1 to keep ids contiguous, which forced that panel to remount and
 * aborted its stream.
 *
 * ## Intended vs visible
 *
 * `order` is what the user asked for and is persisted. `visibleOrder` is what
 * actually fits, derived from the measured width on every render rather than
 * stored — one value cannot lag behind the other if there is only one value.
 * Panels are dropped from the left, which is also where a split adds them.
 *
 * Hiding a panel because the window got too narrow is temporary and touches no
 * storage, so the panel resumes the same conversation when the width returns.
 * Manual close (X) removes it from `order` and releases its conversation, but
 * keeps its model choice so re-splitting reopens on the model that slot last used.
 *
 * ## Why DOM order is fixed
 *
 * Panels are rendered in ascending *slot* order and positioned with the CSS
 * `order` property, so React never moves a panel's DOM node. Reordering by
 * reordering the children would make React `insertBefore` the node, and Chrome
 * resets `scrollTop` on every scrollable descendant of a moved node — a
 * transcript scrolled back through history would jump to the bottom on every
 * drop. Fixed DOM order plus CSS order makes that impossible.
 *
 * ## Animation strategy
 *
 * - Width transitions are enabled only briefly when the panel count changes, then
 *   auto-disabled, so container resize and divider drag stay instant.
 * - Panel show/hide uses AnimatePresence.
 * - Divider drag bypasses transitions for real-time feedback.
 */
export function SplitView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [maxSplitPanels, setMaxSplitPanels] = useState<1 | 2 | 3>(1);

  /**
   * The panels the user has open, left to right. Persisted; changed only by
   * split, close and reorder.
   */
  const [order, setOrder] = useState<number[]>([0]);
  /**
   * Whether the persisted layout has been read back yet. Quick actions wait for
   * this so they route over the user's real layout, not the initial guess.
   */
  const [isLayoutRestored, setIsLayoutRestored] = useState(false);

  /**
   * Width of each panel as a fraction of the available space, **keyed by slot**.
   *
   * Keyed by slot rather than by position so a panel keeps its width when the
   * order changes: a panel that jumped to a new width the instant it was dropped
   * is exactly the flash a reorder must not produce.
   */
  const [ratios, setRatios] = useState<Record<number, number>>({ 0: 1 });
  /** The conversation each slot currently has open, so panels cannot share one. */
  const [sessionIds, setSessionIds] = useState<Record<number, string | null>>({});
  // Dragging state (divider). Holds the *position* of the divider being dragged.
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartRatiosRef = useRef<Record<number, number>>({});
  // External drag tracking (from browser to all panels)
  const [isExternalDragActive, setIsExternalDragActive] = useState(false);
  const [isInternalDragOrigin, setIsInternalDragOrigin] = useState(false);
  const externalDragCounterRef = useRef(0);

  // Whether we should animate width transitions.
  // Only enabled briefly when panel count changes, then auto-disabled.
  // This ensures divider drag and container resize remain immediate.
  const [animateTransitions, setAnimateTransitions] = useState(false);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(true);

  /**
   * Mirrors `order` for the action callbacks below.
   *
   * They are cached per slot for the panel's whole lifetime (see
   * `getPanelRefCallback` for why identity stability matters here), so they must
   * not close over a specific render's `order`.
   */
  const orderRef = useRef(order);
  orderRef.current = order;

  /** Temporarily enable width transition, then auto-disable after the duration */
  const triggerWidthTransition = useCallback(() => {
    if (initialLoadRef.current) return;
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
    }
    setAnimateTransitions(true);
    transitionTimerRef.current = setTimeout(() => {
      setAnimateTransitions(false);
      transitionTimerRef.current = null;
    }, TRANSITION_DURATION_MS + 50); // slight buffer beyond animation duration
  }, []);

  // Cleanup transition timer on unmount
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  // ─── Persistence ──────────────────────────────────────────────────────────

  // Load initial settings and the persisted panel order
  useEffect(() => {
    (async () => {
      const [settings, layout] = await Promise.all([
        storage.getUISettings(),
        storage.getSplitViewLayout(),
      ]);
      setMaxSplitPanels(settings.maxSplitPanels ?? 1);
      const restored = normalizeOrder(layout.order, settings.maxSplitPanels ?? 1);
      setOrder(restored);
      setRatios(equalRatios(restored));
      setIsLayoutRestored(true);
      // Mark initial load as done after first layout settles
      requestAnimationFrame(() => {
        initialLoadRef.current = false;
      });
    })();
  }, []);

  /** Applies a new order and persists it, skipping no-op writes. */
  const persistOrder = useCallback((next: number[]) => {
    setOrder((prev) => (isSameOrder(prev, next) ? prev : next));
    void storage.setSplitViewLayout({ order: next });
  }, []);

  // Watch for settings changes
  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (newValue) {
        setMaxSplitPanels(newValue.maxSplitPanels ?? 1);
      }
    }, []),
  );

  // ─── Drag origin tracking ─────────────────────────────────────────────────

  useEffect(() => {
    const handleDragStart = () => { setIsInternalDragOrigin(true); };
    const handleDragEnd = () => {
      setIsInternalDragOrigin(false);
      setIsExternalDragActive(false);
      externalDragCounterRef.current = 0;
    };
    document.addEventListener('dragstart', handleDragStart);
    document.addEventListener('dragend', handleDragEnd);
    return () => {
      document.removeEventListener('dragstart', handleDragStart);
      document.removeEventListener('dragend', handleDragEnd);
    };
  }, []);

  const handleSplitViewDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isInternalDragOrigin) return;
    externalDragCounterRef.current += 1;
    if (externalDragCounterRef.current === 1) {
      setIsExternalDragActive(true);
    }
  }, [isInternalDragOrigin]);

  const handleSplitViewDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isInternalDragOrigin) return;
    externalDragCounterRef.current -= 1;
    if (externalDragCounterRef.current === 0) {
      setIsExternalDragActive(false);
    }
  }, [isInternalDragOrigin]);

  const handleSplitViewDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleSplitViewDrop = useCallback((_e: React.DragEvent) => {
    externalDragCounterRef.current = 0;
    setIsExternalDragActive(false);
  }, []);

  // ─── Container width monitoring ───────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ─── Compute visible panels ───────────────────────────────────────────────

  // Maximum panels allowed by current width + user setting
  const allowedPanels = computeMaxPanels(containerWidth, maxSplitPanels);

  /**
   * The panels actually on screen, left to right.
   *
   * Derived rather than stored: an effect writing a `visibleOrder` state would
   * always be one commit behind `order` and the measured width, and that lag is
   * what the quick-action readiness gate below had to work around.
   *
   * Panels are dropped from the left, mirroring where a split adds them, so the
   * primary panel is the last to go.
   */
  const visibleOrder = useMemo(
    () => order.slice(Math.max(0, order.length - allowedPanels)),
    [order, allowedPanels],
  );
  const visibleCount = visibleOrder.length;

  /**
   * DOM order: ascending slot, independent of the visual order.
   *
   * React must never reorder these children. Moving a DOM node resets
   * `scrollTop` on all its scrollable descendants, which would yank every
   * transcript to the bottom on each drop. Position is applied with CSS `order`
   * instead.
   */
  const domSlots = useMemo(() => [...visibleOrder].sort((a, b) => a - b), [visibleOrder]);

  /**
   * Mirrors `visibleOrder` for `handleClosePanel`.
   *
   * Read through a ref rather than closed over, for the same reason as
   * `orderRef`: the close callbacks are cached per slot for the panel's whole
   * lifetime (see `getPanelCloseCallback`), so a callback that captured one
   * render's `visibleOrder` would close over a layout the user has since changed.
   */
  const visibleOrderRef = useRef(visibleOrder);
  visibleOrderRef.current = visibleOrder;

  /** Position of each visible slot, for CSS `order` and for the UI role flags. */
  const positionBySlot = useMemo(() => {
    const map = new Map<number, number>();
    visibleOrder.forEach((slot, position) => map.set(slot, position));
    return map;
  }, [visibleOrder]);

  // Reset widths whenever the number of visible panels changes, and animate the
  // transition. Tracked against the previous count rather than derived, because
  // an equal split is only the right answer at the moment the count changes —
  // afterwards the user's divider drags must survive re-renders.
  const prevVisibleCountRef = useRef(visibleCount);
  useEffect(() => {
    if (prevVisibleCountRef.current === visibleCount) return;
    prevVisibleCountRef.current = visibleCount;
    triggerWidthTransition();
    setRatios(equalRatios(visibleOrder));
  }, [visibleCount, visibleOrder, triggerWidthTransition]);

  // Publish the visible layout so other pages (e.g. ChatDebug) can name a panel
  // by the position the user sees.
  useEffect(() => {
    if (!isLayoutRestored) return;
    void storage.setSplitViewVisible({ order: visibleOrder });
  }, [visibleOrder, isLayoutRestored]);

  // Ensure panels respect minimum width
  const availableWidth = containerWidth - (visibleCount - 1) * DIVIDER_WIDTH;
  useEffect(() => {
    if (containerWidth <= 0 || visibleCount <= 1) return;
    const avail = containerWidth - (visibleCount - 1) * DIVIDER_WIDTH;
    if (avail <= 0) return;

    const tooNarrow = visibleOrder.some(
      (slot) => (ratios[slot] ?? 1 / visibleCount) * avail < MIN_PANEL_WIDTH,
    );
    if (tooNarrow) {
      setRatios(equalRatios(visibleOrder));
    }
  }, [containerWidth, visibleCount, visibleOrder, ratios]);

  // ─── Split / Close / Reorder actions ──────────────────────────────────────

  // Whether the split button should be shown
  const canSplit = visibleCount < allowedPanels && order.length < maxSplitPanels;

  /**
   * Split: opens a new panel on the left, in the lowest free slot.
   *
   * Reads `order` from a ref so its identity stays stable — it is handed to every
   * panel as `onSplit`, and a changing identity would re-render all of them.
   */
  const handleSplit = useCallback(() => {
    const current = orderRef.current;
    if (current.length >= maxSplitPanels) return;
    const added = addPanel(current);
    if (!added) return;
    void openPanelSlot(chrome.storage.local, added.slot);
    setRatios((prev) => ratiosForOrder(prev, added.order));
    persistOrder(added.order);
  }, [maxSplitPanels, persistOrder]);

  /**
   * Manual close (X): permanently removes a panel.
   *
   * Committed against `visibleOrder`, not `order`, so what the user sees is the
   * whole layout. Closing relative to `order` instead would free a slot that a
   * width-collapsed panel immediately refills: with `[2,1,0]` collapsed to two
   * panels, closing the left one left `[2,0]` — still two panels, the left one
   * merely swapped its contents, so the close looked like it had failed.
   *
   * Collapsing on its own remains free and reversible; only an explicit layout
   * action commits it. Every panel that was hidden is therefore discarded here
   * too, releasing its conversation claim so another panel may take it.
   *
   * Siblings that survive keep their slot, their storage and their position, so
   * none of them remounts and none of their streams is interrupted — the failure
   * mode of the old contiguous-slot scheme.
   */
  const handleClosePanel = useCallback(async (slot: number) => {
    const current = orderRef.current;
    const visible = visibleOrderRef.current;
    // Only a panel the user can see can be closed. Without this, a stray call for
    // a collapsed slot would be a no-op on `visible` yet still discard the
    // hidden panels below.
    if (!visible.includes(slot)) return;

    const next = removePanel(visible, slot);
    // The last visible panel has no close button, but guard anyway: rendering
    // zero panels is unrecoverable.
    if (next.length === 0) return;
    if (isSameOrder(current, next)) return;

    const discarded = current.filter((id) => !next.includes(id));
    await Promise.all(discarded.map((id) => releasePanelSlot(chrome.storage.local, id)));

    setSessionIds((prev) => {
      const rest = { ...prev };
      let changed = false;
      for (const id of discarded) {
        if (id in rest) {
          delete rest[id];
          changed = true;
        }
      }
      return changed ? rest : prev;
    });
    setRatios((prev) => ratiosForOrder(prev, next));
    persistOrder(next);
  }, [persistOrder]);

  // ─── Session tracking ─────────────────────────────────────────────────────

  const handleSessionChange = useCallback((slot: number, sessionId: string | null) => {
    setSessionIds((prev) => (prev[slot] === sessionId ? prev : { ...prev, [slot]: sessionId }));
  }, []);

  /**
   * Conversations claimed by *other visible* panels, per slot.
   *
   * Memoised as one map rather than computed per panel so each panel's prop keeps
   * a stable identity between renders that do not change the claims.
   *
   * A hidden panel's claim is excluded by the visibility filter rather than
   * deleted: hiding is temporary, and the entry is that panel's own conversation,
   * so it stays correct for when the width returns.
   */
  const occupiedBySlot = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const slot of visibleOrder) {
      const occupied = visibleOrder
        .filter((other) => other !== slot)
        .map((other) => sessionIds[other])
        .filter((id): id is string => typeof id === 'string');
      map.set(slot, occupied);
    }
    return map;
  }, [visibleOrder, sessionIds]);

  // ─── Divider dragging ─────────────────────────────────────────────────────

  const handleDividerMouseDown = useCallback((position: number, e: React.MouseEvent) => {
    e.preventDefault();
    // Cancel any active transition timer to ensure no transition during drag
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
      setAnimateTransitions(false);
    }
    setDraggingDivider(position);
    dragStartXRef.current = e.clientX;
    dragStartRatiosRef.current = { ...ratios };
  }, [ratios]);

  useEffect(() => {
    if (draggingDivider === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const avail = containerWidth - (visibleCount - 1) * DIVIDER_WIDTH;
      if (avail <= 0) return;

      // The divider sits between two positions; resolve them to slots, since
      // ratios are keyed by slot.
      const leftSlot = visibleOrder[draggingDivider];
      const rightSlot = visibleOrder[draggingDivider + 1];
      if (leftSlot === undefined || rightSlot === undefined) return;

      const startRatios = dragStartRatiosRef.current;
      const fallback = 1 / visibleCount;
      const startLeft = startRatios[leftSlot] ?? fallback;
      const startRight = startRatios[rightSlot] ?? fallback;

      const deltaRatio = (e.clientX - dragStartXRef.current) / avail;
      let newLeft = startLeft + deltaRatio;
      let newRight = startRight - deltaRatio;

      const minRatio = MIN_PANEL_WIDTH / avail;
      if (newLeft < minRatio) {
        newLeft = minRatio;
        newRight = startLeft + startRight - minRatio;
      }
      if (newRight < minRatio) {
        newRight = minRatio;
        newLeft = startLeft + startRight - minRatio;
      }

      setRatios((prev) => ({ ...prev, [leftSlot]: newLeft, [rightSlot]: newRight }));
    };

    const handleMouseUp = () => {
      setDraggingDivider(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingDivider, containerWidth, visibleCount, visibleOrder]);

  // ─── Reordering ───────────────────────────────────────────────────────────

  /**
   * Outer width of each visible panel, keyed by slot.
   *
   * The drag needs real pixel widths to decide which neighbour a gesture has
   * cleared, and panels are deliberately resizable, so this cannot be derived
   * from the count.
   */
  const widthBySlot = useMemo(() => {
    const map = new Map<number, number>();
    if (visibleCount === 1) {
      const only = visibleOrder[0];
      if (only !== undefined) map.set(only, containerWidth);
      return map;
    }
    for (const slot of visibleOrder) {
      const ratio = ratios[slot] ?? 1 / visibleCount;
      // Include the divider, so the widths tile the container exactly and a drag
      // across a panel lands where the pointer is.
      map.set(slot, ratio * availableWidth + DIVIDER_WIDTH);
    }
    return map;
  }, [visibleOrder, visibleCount, ratios, availableWidth, containerWidth]);

  /**
   * Commits a reorder.
   *
   * Only the order changes: slots, storage and React keys all stay put, so no
   * panel remounts and an in-flight stream is untouched. Ratios are re-keyed
   * rather than reset, so each panel keeps the width it was dragged with.
   */
  const handleReorder = useCallback((next: number[]) => {
    const current = orderRef.current;
    // A hidden panel is not part of the dragged order, so splice the visible
    // arrangement back into the full one rather than replacing it — otherwise
    // reordering while narrow would silently drop the hidden panels.
    const hidden = current.slice(0, Math.max(0, current.length - next.length));
    persistOrder([...hidden, ...next]);
  }, [persistOrder]);

  const { offsets, draggingSlot, isDragging: isReordering, startDrag } = usePanelDrag({
    order: visibleOrder,
    widthBySlot,
    onReorder: handleReorder,
    // Nothing to reorder with a single panel, and a drag mid-resize would work
    // from stale widths.
    enabled: visibleCount > 1 && draggingDivider === null,
  });

  /**
   * Stable per-slot drag callbacks, for the same reason as the ref callbacks
   * below: an inline closure would change identity every render and re-render
   * every panel, which is exactly what must not happen while one is streaming.
   */
  const dragStartCallbacksRef = useRef<Map<number, (e: React.PointerEvent) => void>>(new Map());

  const getDragStartCallback = useCallback((slot: number) => {
    const existing = dragStartCallbacksRef.current.get(slot);
    if (existing) return existing;
    const callback = (event: React.PointerEvent) => startDrag(slot, event);
    dragStartCallbacksRef.current.set(slot, callback);
    return callback;
  }, [startDrag]);

  // ─── Quick action dispatch ────────────────────────────────────────────────

  // Imperative handles, keyed by slot. Quick actions need to inspect every
  // visible panel's live state (streaming? draft?) before choosing a target, so
  // this cannot be done with props flowing downward.
  const panelHandlesRef = useRef<Map<number, ChatPanelHandle>>(new Map());

  /**
   * How many panels have registered their imperative handle. Mirrors
   * `panelHandlesRef.size` as state, because quick-action readiness has to
   * re-evaluate when a handle attaches and a ref mutation does not re-render.
   */
  const [registeredPanelCount, setRegisteredPanelCount] = useState(0);

  /**
   * Stable per-slot callbacks for the props handed to each panel.
   *
   * An inline `ref={(h) => set(slot, h)}` would be a fresh function every render,
   * so React would detach with `null` and re-attach on each one. Worse, the
   * detach deletes by slot, so a re-render racing with a panel unmount could drop
   * a handle that had just been registered. Caching by slot keeps each callback
   * identity stable for the panel's lifetime — which also keeps the panel out of
   * needless re-renders while a sibling streams.
   */
  const panelRefCallbacksRef = useRef<Map<number, (handle: ChatPanelHandle | null) => void>>(
    new Map(),
  );
  const panelCloseCallbacksRef = useRef<Map<number, () => void>>(new Map());

  const getPanelRefCallback = useCallback((slot: number) => {
    const existing = panelRefCallbacksRef.current.get(slot);
    if (existing) return existing;
    const callback = (handle: ChatPanelHandle | null) => {
      if (handle) {
        panelHandlesRef.current.set(slot, handle);
      } else {
        panelHandlesRef.current.delete(slot);
      }
      // Published as state so quick-action readiness recomputes: a handle
      // attaching is what makes its panel routable.
      setRegisteredPanelCount(panelHandlesRef.current.size);
    };
    panelRefCallbacksRef.current.set(slot, callback);
    return callback;
  }, []);

  const getPanelCloseCallback = useCallback((slot: number) => {
    const existing = panelCloseCallbacksRef.current.get(slot);
    if (existing) return existing;
    const callback = () => { void handleClosePanel(slot); };
    panelCloseCallbacksRef.current.set(slot, callback);
    return callback;
  }, [handleClosePanel]);

  const openSettings = useCallback(() => {
    chrome.runtime.openOptionsPage();
  }, []);

  /**
   * Whether the layout reflects the user's real configuration *and* every panel
   * it implies has registered its imperative handle.
   *
   * All three inputs are asynchronous: the order comes from storage, the width
   * from the first `ResizeObserver` callback, and the handles from the children's
   * ref callbacks, which attach a commit after the render that schedules them.
   * Releasing a quick action early would route it over the initial single-panel
   * guess and ignore a configured split view.
   */
  const isLayoutSettled =
    isLayoutRestored && containerWidth > 0 && registeredPanelCount >= visibleCount;

  useContextMenuPending(
    useCallback((pending) => {
      // Routing iterates the registered handles rather than the visible order:
      // the handle map is the ground truth for which panels actually exist.
      // Handles whose panel has since been hidden are skipped, since routing an
      // action to an unmounted panel would drop it.
      const states: PanelRoutingState[] = [];
      for (const [slot, handle] of panelHandlesRef.current) {
        const position = positionBySlot.get(slot);
        const { isStreaming, hasContent } = handle.getRoutingState();
        states.push({
          slot,
          // A panel that has not been placed yet still has to be routable on a
          // cold open, when the width has not been measured. Treat it as the
          // rightmost candidate rather than excluding it.
          logicalIndex: position === undefined ? slot : visibleCount - 1 - position,
          isStreaming,
          hasContent,
        });
      }

      const route = routeQuickAction(states, pending.autoSend);
      const target =
        (route.slot === undefined ? undefined : panelHandlesRef.current.get(route.slot))
        // `routeQuickAction` has nothing to go on when no panel has registered;
        // take any handle rather than drop the action, since dropping it is what
        // makes the menu look broken.
        ?? panelHandlesRef.current.values().next().value;

      target?.applyQuickAction(pending, route.delivery);
    }, [positionBySlot, visibleCount]),
    // Hold the action until the layout has been restored from storage and the
    // container has been measured. Dispatching before that would route over a
    // one-panel layout and ignore the user's split view.
    { isReady: isLayoutSettled },
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="flex h-screen w-full overflow-hidden"
      style={{ cursor: draggingDivider !== null ? 'col-resize' : undefined }}
      onDragEnter={handleSplitViewDragEnter}
      onDragLeave={handleSplitViewDragLeave}
      onDragOver={handleSplitViewDragOver}
      onDrop={handleSplitViewDrop}
    >
      <AnimatePresence initial={false}>
        {/*
          Nothing renders until the layout is known.

          The alternative — rendering a guessed single panel and correcting it —
          mounts a `ChatPanel` for a slot that may not be in the restored layout
          at all, so it reads a conversation from storage only to unmount and
          discard it, and the user sees a panel appear and immediately collapse.
          The read is fast enough that gating is imperceptible, and quick actions
          already wait for the same signal.
        */}
        {isLayoutRestored && domSlots.map((slot) => {
          const position = positionBySlot.get(slot) ?? 0;
          const isLeftmost = position === 0;
          const isRightmost = position === visibleCount - 1;
          const ratio = ratios[slot] ?? 1 / visibleCount;

          // The wrapper holds the panel *and* the divider to its right, so the
          // two travel together when the order changes. Its width therefore
          // includes the divider, which makes the wrappers sum to exactly the
          // container width.
          const contentWidth = visibleCount === 1 ? containerWidth : ratio * availableWidth;
          const wrapperWidth = contentWidth + (isRightmost ? 0 : DIVIDER_WIDTH);

          // When animateTransitions is true (panel count changing), use smooth
          // animation. Otherwise (resize/drag), use an instant transition.
          const transitionDuration = animateTransitions ? 0.3 : 0;
          const isDragging = draggingSlot === slot;

          return (
            <motion.div
              // Keyed by slot, which is stable for the panel's whole lifetime, so
              // React never remounts a panel — the reason a reorder cannot
              // interrupt a stream or lose an input draft.
              key={`panel-${slot}`}
              className="flex h-full overflow-hidden shrink-0"
              style={{
                // Visual position. DOM order stays ascending by slot; see the
                // component docs for why React must not reorder these nodes.
                order: position,
                // Live drag offset, driven by a motion value so a pointer move
                // never re-renders the panel tree.
                x: offsets.get(slot),
                // The dragged panel rides above its neighbours as they slide past.
                zIndex: isDragging ? 10 : undefined,
                // Lifted look while dragging. Applied inline rather than through
                // `whileDrag` because motion animates `whileDrag` back to a
                // `baseTarget` it cannot read from a class, which leaves a
                // permanent shadow behind (see `options/models/ModelRow.tsx`).
                boxShadow: isDragging
                  ? '0 8px 24px -4px rgb(0 0 0 / 0.25)'
                  : undefined,
              }}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: wrapperWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0, transition: { width: { duration: 0.3, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.2, ease: 'easeInOut' } } }}
              transition={{
                width: { duration: transitionDuration, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: transitionDuration > 0 ? 0.2 : 0, ease: 'easeInOut' },
              }}
            >
              <div
                className="flex-1 h-full min-w-0 overflow-hidden"
                // The whole panel goes inert for the duration of a drag. Without
                // this, sweeping the pointer across a transcript still fires
                // hover states and the attachment drag-and-drop affordances, and
                // releasing over a button would activate it — a reorder could
                // delete a conversation.
                //
                // Safe to include the header: once the gesture has started it is
                // driven entirely by listeners on `document`, so nothing depends
                // on the header still being a pointer target.
                style={isReordering ? { pointerEvents: 'none' } : undefined}
              >
                <ChatPanel
                  ref={getPanelRefCallback(slot)}
                  panelIndex={slot}
                  // Role flags follow *position*, not slot, so they move with the
                  // panel on reorder while its data stays put.
                  showSettings={isRightmost}
                  showSplitButton={isLeftmost && canSplit}
                  showClose={!isRightmost}
                  onSplit={handleSplit}
                  onClose={getPanelCloseCallback(slot)}
                  onOpenSettings={openSettings}
                  occupiedSessionIds={occupiedBySlot.get(slot) ?? []}
                  onSessionChange={handleSessionChange}
                  isExternalDragActive={
                    isExternalDragActive && visibleCount > 1 && !isReordering
                  }
                  onReorderPointerDown={
                    visibleCount > 1 ? getDragStartCallback(slot) : undefined
                  }
                  isDragging={isDragging}
                />
              </div>
              {!isRightmost && (
                <div
                  className="h-full flex items-center justify-center shrink-0 group cursor-col-resize hover:bg-muted/60 active:bg-muted transition-colors"
                  style={{ width: `${DIVIDER_WIDTH}px` }}
                  onMouseDown={(e) => handleDividerMouseDown(position, e)}
                >
                  <div className="w-0.5 h-8 rounded-full bg-border group-hover:bg-foreground/30 group-active:bg-foreground/50 transition-colors" />
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

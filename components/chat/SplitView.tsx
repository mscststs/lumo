import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChatPanel, type ChatPanelHandle } from '@/components/chat/ChatPanel';
import { useStorageWatch } from '@/store/useStorageWatch';
import { useContextMenuPending } from '@/store/useContextMenuPending';
import { storage } from '@/store/storage';
import {
  closePanelSlot,
  openPanelSlot,
  shiftPanelSessions,
} from '@/lib/panel-storage';
import { routeQuickAction, type PanelRoutingState } from '@/lib/quick-action-routing';
import type { UISettings } from '@/types';

/** Minimum width for each panel in pixels */
const MIN_PANEL_WIDTH = 360;
/** Width threshold to allow 2 panels */
const THRESHOLD_2_PANELS = 750;
/** Width threshold to allow 3 panels */
const THRESHOLD_3_PANELS = 1150;
/** Storage key for persisting the user's intended panel count */
const INTENDED_PANELS_KEY = 'splitView_intendedPanelCount';
/** Storage key for the actual visible panel count (for other pages to read) */
const VISIBLE_PANELS_KEY = 'splitView_visiblePanelCount';

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
 * Key concepts:
 * - intendedPanelCount: user's desired number of panels (persisted). Changed
 *   only by explicit user actions (split button / close button).
 * - visiblePanelCount: how many panels are actually rendered, constrained by
 *   available width. = min(intendedPanelCount, allowedByWidth).
 * - Hiding a panel because the window got too narrow is temporary: only the
 *   in-memory session claim is dropped, so another panel may take that
 *   conversation over meanwhile. Storage is left untouched, so when width
 *   restores the panel resumes the same conversation (unless it was claimed).
 * - Manual close (X button) permanently reduces intendedPanelCount. It releases
 *   the slot's conversation but keeps its model choice, so re-splitting reopens
 *   the panel on the model that slot last used.
 *
 * Panel ID scheme:
 *   - panelId 0 = rightmost (primary) panel — always present, has Settings button
 *   - panelId 1 = second from right
 *   - panelId 2 = third from right (leftmost when 3 panels open)
 *
 * Rendering order is left-to-right, so with N visible panels, the render array
 * indices map to panelIds as: renderIndex i → panelId (N-1-i).
 *
 * Animation strategy:
 * - Panel width transitions are ONLY enabled briefly when panel count changes
 *   (triggered by split/close/width threshold crossing). They auto-disable after
 *   the transition completes, so container resize and divider drag remain instant.
 * - Panel show/hide uses AnimatePresence with opacity + scale animation
 * - Divider drag bypasses transitions for real-time feedback
 */
export function SplitView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [maxSplitPanels, setMaxSplitPanels] = useState<1 | 2 | 3>(1);

  // User's intended panel count (persisted, changed only by split/close actions)
  const [intendedPanelCount, setIntendedPanelCount] = useState(1);
  // Actually visible panels (may be less than intended due to width constraints)
  const [visiblePanelCount, setVisiblePanelCount] = useState(1);
  // Whether the persisted panel count has been read back yet. Quick actions wait
  // for this so they route over the user's real layout, not the initial guess.
  const [isCountRestored, setIsCountRestored] = useState(false);

  // Ratio-based sizes for each panel (index = render position, left-to-right)
  const [panelRatios, setPanelRatios] = useState<number[]>([1]);
  // Track occupied session IDs per panelId (index = panelId)
  const [sessionIds, setSessionIds] = useState<(string | null)[]>([null, null, null]);
  // Generation counter: incremented on close/hide to force remount of shifted panels
  const [generation, setGeneration] = useState(0);
  // Dragging state
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartRatiosRef = useRef<number[]>([]);
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

  // Load initial settings and intended panel count
  useEffect(() => {
    (async () => {
      const [settings, result] = await Promise.all([
        storage.getUISettings(),
        chrome.storage.local.get(INTENDED_PANELS_KEY),
      ]);
      setMaxSplitPanels(settings.maxSplitPanels ?? 1);
      const saved = result[INTENDED_PANELS_KEY] as number | undefined;
      if (saved && saved >= 1 && saved <= 3) {
        setIntendedPanelCount(saved);
      }
      setIsCountRestored(true);
      // Mark initial load as done after first layout settles
      requestAnimationFrame(() => {
        initialLoadRef.current = false;
      });
    })();
  }, []);

  // Persist intended panel count
  const persistIntendedCount = useCallback((count: number) => {
    setIntendedPanelCount(count);
    void chrome.storage.local.set({ [INTENDED_PANELS_KEY]: count });
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

  // The target visible count: intended, capped by what the width allows
  const targetVisibleCount = Math.min(intendedPanelCount, allowedPanels);

  // React to width changes: adjust visible panel count
  useEffect(() => {
    if (containerWidth <= 0) return; // Skip before first measurement

    if (targetVisibleCount < visiblePanelCount) {
      // Width shrunk — hide panels from the left (highest panelId). Only the
      // session claim is dropped, never storage: hiding is temporary, so the
      // panel must be able to resume this conversation when width returns.
      // Dropping the claim also lets a still-visible panel open it meanwhile.
      setSessionIds((prev) => {
        const next = [...prev];
        for (let id = targetVisibleCount; id < visiblePanelCount; id++) {
          next[id] = null;
        }
        return next;
      });
      triggerWidthTransition();
      setVisiblePanelCount(targetVisibleCount);
      setPanelRatios(Array(targetVisibleCount).fill(1 / targetVisibleCount));
    } else if (targetVisibleCount > visiblePanelCount) {
      // Width grew — show panels that were temporarily hidden.
      triggerWidthTransition();
      setVisiblePanelCount(targetVisibleCount);
      setPanelRatios(Array(targetVisibleCount).fill(1 / targetVisibleCount));
    }
  }, [targetVisibleCount, visiblePanelCount, containerWidth, triggerWidthTransition]);

  // Persist visible panel count so other pages (e.g. ChatDebug) can read it
  useEffect(() => {
    void chrome.storage.local.set({ [VISIBLE_PANELS_KEY]: visiblePanelCount });
  }, [visiblePanelCount]);

  // Ensure panels respect minimum width
  useEffect(() => {
    if (containerWidth <= 0 || visiblePanelCount <= 1) return;
    const dividerW = 8;
    const totalDividers = visiblePanelCount - 1;
    const availWidth = containerWidth - totalDividers * dividerW;

    let needsAdjustment = false;
    for (let i = 0; i < visiblePanelCount; i++) {
      const ratio = panelRatios[i] ?? (1 / visiblePanelCount);
      if (ratio * availWidth < MIN_PANEL_WIDTH) {
        needsAdjustment = true;
        break;
      }
    }

    if (needsAdjustment) {
      setPanelRatios(Array(visiblePanelCount).fill(1 / visiblePanelCount));
    }
  }, [containerWidth, visiblePanelCount, panelRatios]);

  // ─── Split / Close actions ────────────────────────────────────────────────

  // Whether the split button should be shown
  const canSplit = visiblePanelCount < allowedPanels && intendedPanelCount < maxSplitPanels;

  // Split: user explicitly requests a new panel on the left
  const handleSplit = useCallback(() => {
    const newIntended = intendedPanelCount + 1;
    if (newIntended > maxSplitPanels) return;
    void openPanelSlot(chrome.storage.local, newIntended - 1);
    persistIntendedCount(newIntended);
  }, [intendedPanelCount, maxSplitPanels, persistIntendedCount]);

  /**
   * Manual close (X button): permanently removes a panel, shifting the slots
   * above it down so panel ids stay contiguous.
   */
  const handleClosePanel = useCallback(async (closedPanelId: number) => {
    if (intendedPanelCount <= 1) return;

    await closePanelSlot(chrome.storage.local, closedPanelId, intendedPanelCount);

    setSessionIds((prev) => shiftPanelSessions(prev, closedPanelId, intendedPanelCount));

    persistIntendedCount(intendedPanelCount - 1);
    setGeneration((g) => g + 1);
  }, [intendedPanelCount, persistIntendedCount]);

  // ─── Session tracking ─────────────────────────────────────────────────────

  const handleSessionChange = useCallback((panelId: number, sessionId: string | null) => {
    setSessionIds((prev) => {
      const next = [...prev];
      next[panelId] = sessionId;
      return next;
    });
  }, []);

  // Get occupied session IDs for a given panelId (all OTHER visible panels' sessions)
  const getOccupiedSessionIds = useCallback((panelId: number): string[] => {
    return sessionIds
      .filter((_, i) => i !== panelId && i < visiblePanelCount)
      .filter((id): id is string => id !== null);
  }, [sessionIds, visiblePanelCount]);

  // ─── Divider dragging ─────────────────────────────────────────────────────

  const handleDividerMouseDown = useCallback((dividerIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    // Cancel any active transition timer to ensure no transition during drag
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
      setAnimateTransitions(false);
    }
    setDraggingDivider(dividerIndex);
    dragStartXRef.current = e.clientX;
    dragStartRatiosRef.current = [...panelRatios];
  }, [panelRatios]);

  useEffect(() => {
    if (draggingDivider === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const dividerW = 8;
      const totalDividers = visiblePanelCount - 1;
      const availWidth = containerWidth - totalDividers * dividerW;
      if (availWidth <= 0) return;

      const deltaX = e.clientX - dragStartXRef.current;
      const deltaRatio = deltaX / availWidth;

      const startRatios = dragStartRatiosRef.current;
      const leftIdx = draggingDivider;
      const rightIdx = draggingDivider + 1;

      const startLeft = startRatios[leftIdx] ?? (1 / visiblePanelCount);
      const startRight = startRatios[rightIdx] ?? (1 / visiblePanelCount);

      let newLeftRatio = startLeft + deltaRatio;
      let newRightRatio = startRight - deltaRatio;

      const minRatio = MIN_PANEL_WIDTH / availWidth;

      if (newLeftRatio < minRatio) {
        newLeftRatio = minRatio;
        newRightRatio = startLeft + startRight - minRatio;
      }
      if (newRightRatio < minRatio) {
        newRightRatio = minRatio;
        newLeftRatio = startLeft + startRight - minRatio;
      }

      const newRatios = [...startRatios];
      newRatios[leftIdx] = newLeftRatio;
      newRatios[rightIdx] = newRightRatio;
      setPanelRatios(newRatios);
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
  }, [draggingDivider, containerWidth, visiblePanelCount]);

  // ─── Build render list ────────────────────────────────────────────────────

  const panelIds = useMemo(() => {
    return Array.from({ length: visiblePanelCount }, (_, i) => visiblePanelCount - 1 - i);
  }, [visiblePanelCount]);

  // ─── Quick action dispatch ────────────────────────────────────────────────

  // Imperative handles, indexed by panelId. Quick actions need to inspect every
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
   * Stable per-panel ref callbacks.
   *
   * An inline `ref={(h) => set(panelId, h)}` would be a fresh function every
   * render, so React would detach with `null` and re-attach on each one. Worse,
   * the detach deletes by panelId, so a re-render racing with a panel unmount
   * could drop a handle that had just been registered. Memoising by panelId
   * keeps each callback identity stable for the panel's lifetime.
   */
  const panelRefCallbacksRef = useRef<Map<number, (handle: ChatPanelHandle | null) => void>>(
    new Map(),
  );

  const getPanelRefCallback = useCallback((panelId: number) => {
    const existing = panelRefCallbacksRef.current.get(panelId);
    if (existing) return existing;
    const callback = (handle: ChatPanelHandle | null) => {
      if (handle) {
        panelHandlesRef.current.set(panelId, handle);
      } else {
        panelHandlesRef.current.delete(panelId);
      }
      // Published as state so quick-action readiness recomputes: a handle
      // attaching is what makes its panel routable.
      setRegisteredPanelCount(panelHandlesRef.current.size);
    };
    panelRefCallbacksRef.current.set(panelId, callback);
    return callback;
  }, []);

  /**
   * Whether the layout reflects the user's real configuration *and* every panel
   * it implies has registered its imperative handle.
   *
   * All three inputs are asynchronous: the panel count comes from storage, the
   * width from the first `ResizeObserver` callback, and the handles from the
   * children's ref callbacks, which attach a commit after the render that
   * schedules them. Releasing a quick action early would route it over the
   * initial single-panel guess and ignore a configured split view.
   *
   * The comparison is against `targetVisibleCount` rather than
   * `visiblePanelCount`: the latter is itself still catching up (an effect writes
   * it), so it briefly equals the handle count while a second panel is pending —
   * which would let the gate open one commit too early.
   */
  const isLayoutSettled =
    isCountRestored && containerWidth > 0 && registeredPanelCount >= targetVisibleCount;

  useContextMenuPending(
    useCallback((pending) => {
      // Routing iterates the registered handles rather than `visiblePanelCount`.
      // The handle map is the ground truth for which panels actually exist, and
      // avoids depending on a count that lands asynchronously.
      const states: PanelRoutingState[] = [];
      for (const [panelId, handle] of panelHandlesRef.current) {
        const { isStreaming, hasContent } = handle.getRoutingState();
        states.push({ panelId, isStreaming, hasContent });
      }

      const route = routeQuickAction(states, pending.autoSend);
      const target =
        panelHandlesRef.current.get(route.panelId)
        // `routeQuickAction` falls back to panel 0 when it has nothing to go on;
        // if even that has not mounted, take any handle rather than drop the
        // action, since dropping it is what makes the menu look broken.
        ?? panelHandlesRef.current.values().next().value;

      target?.applyQuickAction(pending, route.delivery);
    }, []),
    // Hold the action until the panel count has been restored from storage and
    // the container has been measured. Dispatching before that would route over
    // a one-panel layout and ignore the user's split view.
    { isReady: isLayoutSettled },
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  const dividerWidth = 8;
  const totalDividers = visiblePanelCount - 1;
  const availableWidth = containerWidth - totalDividers * dividerWidth;

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
        {panelIds.map((panelId, renderIndex) => {
          const ratio = panelRatios[renderIndex] ?? (1 / visiblePanelCount);
          const panelWidth = visiblePanelCount === 1
            ? containerWidth
            : ratio * availableWidth;
          const isLeftmost = renderIndex === 0;
          const isRightmost = renderIndex === visiblePanelCount - 1;
          const panelKey = panelId === 0 ? 'panel-0' : `panel-${panelId}-g${generation}`;

          // When animateTransitions is true (panel count changing), use smooth animation.
          // Otherwise (resize/drag), use instant transition (duration 0).
          const transitionDuration = animateTransitions ? 0.3 : 0;

          return (
            <motion.div
              key={panelKey}
              className="flex h-full overflow-hidden shrink-0"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: panelWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0, transition: { width: { duration: 0.3, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.2, ease: 'easeInOut' } } }}
              transition={{
                width: { duration: transitionDuration, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: transitionDuration > 0 ? 0.2 : 0, ease: 'easeInOut' },
              }}
            >
              <div className="flex-1 h-full min-w-0 overflow-hidden">
                <ChatPanel
                  ref={getPanelRefCallback(panelId)}
                  panelIndex={panelId}
                  showSettings={isRightmost}
                  showSplitButton={isLeftmost && canSplit}
                  showClose={panelId > 0}
                  onSplit={handleSplit}
                  onClose={() => handleClosePanel(panelId)}
                  onOpenSettings={() => chrome.runtime.openOptionsPage()}
                  occupiedSessionIds={getOccupiedSessionIds(panelId)}
                  onSessionChange={handleSessionChange}
                  isExternalDragActive={isExternalDragActive && visiblePanelCount > 1}
                />
              </div>
              {renderIndex < visiblePanelCount - 1 && (
                <div
                  className="h-full flex items-center justify-center shrink-0 group cursor-col-resize hover:bg-muted/60 active:bg-muted transition-colors"
                  style={{ width: `${dividerWidth}px` }}
                  onMouseDown={(e) => handleDividerMouseDown(renderIndex, e)}
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

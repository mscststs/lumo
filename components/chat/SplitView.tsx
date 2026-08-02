import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useStorageWatch } from '@/store/useStorageWatch';
import { storage } from '@/store/storage';
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

/**
 * Determines how many panels can fit given the container width and user setting.
 */
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
 * - When width shrinks and panels are hidden temporarily, their conversations
 *   are released (other panels can switch to them). When width restores, the
 *   panels reappear as fresh new chats.
 * - Manual close (X button) permanently reduces intendedPanelCount.
 *
 * Panel ID scheme:
 *   - panelId 0 = rightmost (primary) panel — always present, has Settings button
 *   - panelId 1 = second from right
 *   - panelId 2 = third from right (leftmost when 3 panels open)
 *
 * Rendering order is left-to-right, so with N visible panels, the render array
 * indices map to panelIds as: renderIndex i → panelId (N-1-i).
 */
export function SplitView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [maxSplitPanels, setMaxSplitPanels] = useState<1 | 2 | 3>(1);

  // User's intended panel count (persisted, changed only by split/close actions)
  const [intendedPanelCount, setIntendedPanelCount] = useState(1);
  // Actually visible panels (may be less than intended due to width constraints)
  const [visiblePanelCount, setVisiblePanelCount] = useState(1);

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
      // Width shrunk — hide panels from the left (highest panelId).
      // Keep their storage keys intact so they can restore later.
      // Only clear sessionIds so other panels can switch to those conversations.
      setSessionIds((prev) => {
        const next = [...prev];
        for (let id = targetVisibleCount; id < visiblePanelCount; id++) {
          next[id] = null;
        }
        return next;
      });
      setVisiblePanelCount(targetVisibleCount);
      setPanelRatios(Array(targetVisibleCount).fill(1 / targetVisibleCount));
    } else if (targetVisibleCount > visiblePanelCount) {
      // Width grew — show panels that were temporarily hidden.
      // They will remount and read their stored conversation from storage.
      // If another panel has since taken that conversation, useConversations
      // will find it occupied and the panel will show a new chat naturally.
      setVisiblePanelCount(targetVisibleCount);
      setPanelRatios(Array(targetVisibleCount).fill(1 / targetVisibleCount));
      setGeneration((g) => g + 1);
    }
  }, [targetVisibleCount, visiblePanelCount, containerWidth]);

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
    // The new panel gets the highest panelId (newIntended - 1).
    // Clear its conversation key so it starts as a fresh new chat.
    const newPanelId = newIntended - 1;
    const convKey = `currentConversationId_${newPanelId}`;
    void chrome.storage.local.set({ [convKey]: null });
    persistIntendedCount(newIntended);
    // visiblePanelCount will update via the targetVisibleCount effect
  }, [intendedPanelCount, maxSplitPanels, persistIntendedCount]);

  /**
   * Manual close (X button): permanently removes a panel.
   * Shifts storage keys for panels above the closed one.
   */
  const handleClosePanel = useCallback(async (closedPanelId: number) => {
    if (intendedPanelCount <= 1) return;

    const newIntended = intendedPanelCount - 1;

    // Migrate storage: shift panels with id > closedPanelId down by one
    for (let id = closedPanelId; id < intendedPanelCount - 1; id++) {
      const sourceId = id + 1;
      const sourceModelKey = sourceId === 0 ? 'selectedModel' : `selectedModel_${sourceId}`;
      const sourceConvKey = sourceId === 0 ? 'currentConversationId' : `currentConversationId_${sourceId}`;
      const targetModelKey = id === 0 ? 'selectedModel' : `selectedModel_${id}`;
      const targetConvKey = id === 0 ? 'currentConversationId' : `currentConversationId_${id}`;

      const result = await chrome.storage.local.get([sourceModelKey, sourceConvKey]);
      const writes: Record<string, unknown> = {};
      writes[targetModelKey] = result[sourceModelKey] ?? null;
      writes[targetConvKey] = result[sourceConvKey] ?? null;
      await chrome.storage.local.set(writes);
    }

    // Clear the highest slot (no longer used)
    const highestId = intendedPanelCount - 1;
    const highModelKey = highestId === 0 ? 'selectedModel' : `selectedModel_${highestId}`;
    const highConvKey = highestId === 0 ? 'currentConversationId' : `currentConversationId_${highestId}`;
    await chrome.storage.local.remove([highModelKey, highConvKey]);

    // Shift session IDs
    setSessionIds((prev) => {
      const next = [...prev];
      for (let id = closedPanelId; id < intendedPanelCount - 1; id++) {
        next[id] = next[id + 1] ?? null;
      }
      next[intendedPanelCount - 1] = null;
      return next;
    });

    persistIntendedCount(newIntended);
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
      {panelIds.map((panelId, renderIndex) => {
        const ratio = panelRatios[renderIndex] ?? (1 / visiblePanelCount);
        const panelWidth = visiblePanelCount === 1 ? '100%' : `${ratio * availableWidth}px`;
        const isLeftmost = renderIndex === 0;
        const isRightmost = renderIndex === visiblePanelCount - 1;

        return (
          <div key={panelId === 0 ? 'panel-0' : `panel-${panelId}-g${generation}`} className="flex h-full" style={{ width: panelWidth }}>
            <div className="flex-1 h-full min-w-0 overflow-hidden">
              <ChatPanel
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
          </div>
        );
      })}
    </div>
  );
}

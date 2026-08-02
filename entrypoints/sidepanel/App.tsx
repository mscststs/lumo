import { useEffect, useRef } from 'react';
import { ThemeInit } from '@/lib/theme';
import { SplitView } from '@/components/chat/SplitView';
import { CONTEXT_MENU_PENDING_KEY, type ContextMenuPendingData } from '@/lib/context-menu';

/**
 * Sidepanel root — sets up theme, i18n, and consumes context-menu pending data.
 * The actual chat UI is delegated to SplitView which manages one or more ChatPanels.
 */
export default function App() {
  const lastContextMenuTimestampRef = useRef(0);

  // We need a ref to the first panel to forward context-menu data.
  // For now we broadcast it as a custom event that ChatPanel can pick up.
  const broadcastContextMenuData = (pending: ContextMenuPendingData) => {
    window.dispatchEvent(new CustomEvent('lumo-context-menu-pending', { detail: pending }));
  };

  // ─── Context menu pending selection listener ─────────────────────────────
  useEffect(() => {
    const addPendingAttachment = (pending: ContextMenuPendingData) => {
      if (pending.timestamp <= lastContextMenuTimestampRef.current) return;
      lastContextMenuTimestampRef.current = pending.timestamp;
      broadcastContextMenuData(pending);
      // Clear the pending data so it's not re-consumed on next open
      void chrome.storage.session.remove(CONTEXT_MENU_PENDING_KEY);
    };

    // Check if there's a pending context menu selection when the panel opens
    const consumePending = async () => {
      try {
        const result = await chrome.storage.session.get(CONTEXT_MENU_PENDING_KEY);
        const pending = result[CONTEXT_MENU_PENDING_KEY] as ContextMenuPendingData | undefined;
        if (pending && Date.now() - pending.timestamp < 30_000) {
          requestAnimationFrame(() => {
            addPendingAttachment(pending);
          });
        }
      } catch {
        // Ignore errors
      }
    };

    void consumePending();

    // Also listen for new context menu selections while the panel is already open
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      if (CONTEXT_MENU_PENDING_KEY in changes) {
        const pending = changes[CONTEXT_MENU_PENDING_KEY]?.newValue as ContextMenuPendingData | undefined;
        if (pending) {
          addPendingAttachment(pending);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  return (
    <div className="h-screen w-full bg-background overflow-hidden">
      <ThemeInit />
      <SplitView />
    </div>
  );
}

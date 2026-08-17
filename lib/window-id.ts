/**
 * Window identity for per-window state isolation.
 *
 * Each browser window gets its own side panel instance, but `chrome.storage` is
 * extension-wide. This module provides the window ID that keys per-window state,
 * plus a React context so any component in the side panel tree can read it.
 *
 * ## Obtaining the window ID
 *
 * The side panel runs in a trusted extension context, so `chrome.windows.getCurrent()`
 * is available directly. This is simpler than routing through the background.
 *
 * ## Lifecycle
 *
 * The window ID is fetched once at mount time and never changes (a side panel
 * cannot migrate between windows). Components that depend on it gate their
 * initialization on the value being available (non-null).
 */

import { createContext, useContext, useEffect, useState } from 'react';

export const WindowIdContext = createContext<number | null>(null);

/**
 * Read the current window's ID. Returns `null` until the async query resolves.
 */
export function useWindowIdInit(): number | null {
  const [windowId, setWindowId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    chrome.windows.getCurrent().then((win) => {
      if (!cancelled && win.id != null) {
        setWindowId(win.id);
      }
    }).catch(() => {
      // Fallback: if somehow windows API fails, use a random ID so the
      // instance at least doesn't collide with others in the same session.
      if (!cancelled) setWindowId(Math.floor(Math.random() * 1_000_000));
    });
    return () => { cancelled = true; };
  }, []);

  return windowId;
}

/**
 * Read the window ID from context. Returns `null` before initialization.
 */
export function useWindowId(): number | null {
  return useContext(WindowIdContext);
}

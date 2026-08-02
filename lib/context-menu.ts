/**
 * Context Menu Registration & Handling
 *
 * Creates three right-click menu items:
 * 1. "Ask Lumo" — shown when right-clicking on an empty area (no selection).
 *    Opens the side panel.
 * 2. "Ask Lumo about selection" — shown when text is selected.
 *    Opens the side panel and passes the selection as a text attachment.
 * 3. "Ask Lumo about this image" — shown when right-clicking on an image.
 *    Opens the side panel and passes the image as an image attachment.
 *
 * Communication with the side panel is done via `chrome.storage.session` so the
 * panel can pick up the pending attachment even if it was not yet open when the
 * menu item was clicked.
 */

import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';

// ─── Constants ────────────────────────────────────────────────────────────────

const MENU_ID_ASK = 'lumo-ask' as const;
const MENU_ID_ASK_SELECTION = 'lumo-ask-selection' as const;
const MENU_ID_ASK_IMAGE = 'lumo-ask-image' as const;

/**
 * Session storage key used to pass context-menu selections to the side panel.
 * The side panel clears it after consuming.
 */
export const CONTEXT_MENU_PENDING_KEY = 'contextMenuPending';

export interface ContextMenuPendingData {
  type: 'text' | 'image';
  /** The selected text (when type is 'text') */
  text?: string;
  /** The image source URL (when type is 'image') */
  imageUrl?: string;
  /** The page URL where the action was made */
  pageUrl: string;
  /** Timestamp to avoid processing stale entries */
  timestamp: number;
}

// ─── Menu title helpers ───────────────────────────────────────────────────────

interface MenuTitles {
  ask: string;
  askSelection: string;
  askImage: string;
}

async function getMenuTitles(): Promise<MenuTitles> {
  try {
    const result = await chrome.storage.local.get('uiSettings');
    const lang = (result.uiSettings as { language?: string } | undefined)?.language ?? 'en';
    if (lang === 'zh') {
      return {
        ask: zh.sidebar.contextMenu.ask,
        askSelection: zh.sidebar.contextMenu.askSelection,
        askImage: zh.sidebar.contextMenu.askImage,
      };
    }
  } catch {
    // fallback
  }
  return {
    ask: en.sidebar.contextMenu.ask,
    askSelection: en.sidebar.contextMenu.askSelection,
    askImage: en.sidebar.contextMenu.askImage,
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register context menu items. Must be called synchronously during service
 * worker initialisation (inside `defineBackground`) to comply with
 * `svc-register-listeners-synchronously`.
 */
export function registerContextMenus() {
  // Remove any stale entries from previous sessions, then create fresh ones.
  chrome.contextMenus.removeAll(() => {
    void createMenuItems();
  });

  // Listen for clicks
  chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

  // Re-create menus when language changes so titles stay in sync
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if ('uiSettings' in changes) {
      chrome.contextMenus.removeAll(() => {
        void createMenuItems();
      });
    }
  });
}

async function createMenuItems() {
  const titles = await getMenuTitles();

  chrome.contextMenus.create({
    id: MENU_ID_ASK,
    title: titles.ask,
    contexts: ['page'],
  });

  chrome.contextMenus.create({
    id: MENU_ID_ASK_SELECTION,
    title: titles.askSelection,
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: MENU_ID_ASK_IMAGE,
    title: titles.askImage,
    contexts: ['image'],
  });
}

// ─── Click handler ────────────────────────────────────────────────────────────

function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
) {
  const tabId = tab?.id;
  if (!tabId) return;

  if (info.menuItemId === MENU_ID_ASK) {
    // Just open side panel
    void chrome.sidePanel.open({ tabId });
  } else if (info.menuItemId === MENU_ID_ASK_SELECTION) {
    const selectedText = info.selectionText?.trim();
    if (selectedText) {
      const pending: ContextMenuPendingData = {
        type: 'text',
        text: selectedText,
        pageUrl: info.pageUrl ?? tab?.url ?? '',
        timestamp: Date.now(),
      };
      void chrome.storage.session.set({ [CONTEXT_MENU_PENDING_KEY]: pending });
    }
    void chrome.sidePanel.open({ tabId });
  } else if (info.menuItemId === MENU_ID_ASK_IMAGE) {
    const srcUrl = info.srcUrl;
    if (srcUrl) {
      const pending: ContextMenuPendingData = {
        type: 'image',
        imageUrl: srcUrl,
        pageUrl: info.pageUrl ?? tab?.url ?? '',
        timestamp: Date.now(),
      };
      void chrome.storage.session.set({ [CONTEXT_MENU_PENDING_KEY]: pending });
    }
    void chrome.sidePanel.open({ tabId });
  }
}

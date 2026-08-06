/**
 * Context Menu Registration & Handling
 *
 * Builds the right-click menu from the {@link QUICK_ACTIONS} registry. Each
 * right-click context (page / selection / image) gets one top-level "Lumo" entry
 * with the scope's actions as a submenu, so the user's context menu never gains
 * more than one item per scope no matter how many actions exist.
 *
 * Communication with the side panel is done via `chrome.storage.session` so the
 * panel can pick up the pending action even if it was not yet open when the
 * menu item was clicked.
 */

import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import {
  QUICK_ACTIONS,
  QUICK_ACTION_PARENT_IDS,
  findQuickAction,
  quickActionPromptPath,
  quickActionTitlePath,
  type QuickActionDefinition,
  type QuickActionScope,
} from '@/lib/quick-actions';
import type { PageContext } from '@/lib/page-context';

// ─── Pending payload contract ────────────────────────────────────────────────

/**
 * Session storage key used to pass context-menu actions to the side panel.
 * The side panel clears it after consuming.
 */
export const CONTEXT_MENU_PENDING_KEY = 'contextMenuPending';

export interface ContextMenuPendingData {
  /** Id of the {@link QuickActionDefinition} that was clicked. */
  actionId: string;
  /** Which payload kind accompanies the action. */
  type: 'page' | 'text' | 'image';
  /** The selected text (when type is 'text') */
  text?: string;
  /** The image source URL (when type is 'image') */
  imageUrl?: string;
  /**
   * Identity of the page the action was fired from. Always present so the model
   * knows — and can address via the `page_*` tools — which tab it is working on.
   */
  pageContext: PageContext;
  /**
   * Prompt to place in the chat input, already localised in the background.
   * Absent for actions that only attach context (plain "Ask Lumo").
   */
  prompt?: string;
  /** Whether the panel may dispatch this without waiting for the user. */
  autoSend: boolean;
  /** Timestamp to avoid processing stale entries */
  timestamp: number;
}

// ─── i18n without React ──────────────────────────────────────────────────────

/**
 * The background has no i18next instance, so it reads the locale objects
 * directly. Resolution mirrors `i18n/index.ts`: the stored language, falling
 * back to English.
 */
async function loadLocale(): Promise<typeof en> {
  try {
    const result = await chrome.storage.local.get('uiSettings');
    const lang = (result.uiSettings as { language?: string } | undefined)?.language ?? 'en';
    if (lang === 'zh') return zh;
  } catch {
    // Fall through to English.
  }
  return en;
}

/** Resolves a dotted i18n path against a locale object. */
function resolvePath(locale: typeof en, path: string): string | undefined {
  const value = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], locale);
  return typeof value === 'string' ? value : undefined;
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register context menu items. Must be called synchronously during service
 * worker initialisation (inside `defineBackground`) to comply with
 * `svc-register-listeners-synchronously`.
 */
export function registerContextMenus() {
  // Remove any stale entries from previous sessions, then create fresh ones.
  rebuildMenus();

  // Listen for clicks
  chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

  // Re-create menus when language changes so titles stay in sync
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if ('uiSettings' in changes) {
      rebuildMenus();
    }
  });
}

function rebuildMenus() {
  chrome.contextMenus.removeAll(() => {
    void createMenuItems();
  });
}

/**
 * The `chrome.contextMenus` context each scope binds to.
 *
 * Typed off `create`'s own parameter so it satisfies the non-empty mutable tuple
 * the API requires, instead of restating that shape by hand.
 */
type MenuContexts = NonNullable<chrome.contextMenus.CreateProperties['contexts']>;

const SCOPE_CONTEXTS: Record<QuickActionScope, MenuContexts> = {
  page: ['page'],
  selection: ['selection'],
  image: ['image'],
};

async function createMenuItems() {
  const locale = await loadLocale();
  const rootTitle = locale.sidebar.contextMenu.root;

  // One parent per scope. Chrome shows a parent only when at least one child
  // matches the current context, so an empty scope simply never appears.
  const scopes = Object.keys(QUICK_ACTION_PARENT_IDS) as QuickActionScope[];
  for (const scope of scopes) {
    chrome.contextMenus.create({
      id: QUICK_ACTION_PARENT_IDS[scope],
      title: rootTitle,
      contexts: SCOPE_CONTEXTS[scope],
    });
  }

  for (const action of QUICK_ACTIONS) {
    const title = resolvePath(locale, quickActionTitlePath(action));
    if (!title) continue; // Missing translation: skip rather than show a raw key.
    chrome.contextMenus.create({
      id: action.id,
      parentId: QUICK_ACTION_PARENT_IDS[action.scope],
      title,
      contexts: SCOPE_CONTEXTS[action.scope],
    });
  }
}

// ─── Click handler ────────────────────────────────────────────────────────────

function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
) {
  const tabId = tab?.id;
  if (!tabId) return;

  const action = findQuickAction(String(info.menuItemId));
  if (!action) return;

  // Open the panel first and unconditionally: the payload write is async, and
  // the panel listens for the storage change, so opening early shortens the
  // perceived latency without risking a missed payload.
  void chrome.sidePanel.open({ tabId });
  void storePendingAction(info, tab, tabId, action);
}

async function storePendingAction(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  tabId: number,
  action: QuickActionDefinition,
) {
  const locale = await loadLocale();
  const promptPath = quickActionPromptPath(action);
  const prompt = promptPath ? resolvePath(locale, promptPath) : undefined;

  const pageContext: PageContext = {
    tabId,
    title: tab?.title ?? '',
    url: info.pageUrl ?? tab?.url ?? '',
  };

  const pending: ContextMenuPendingData = {
    actionId: action.id,
    type: action.scope === 'selection' ? 'text' : action.scope === 'image' ? 'image' : 'page',
    pageContext,
    prompt,
    // An action with no prompt has nothing to send, so it can never auto-send
    // regardless of how the registry entry is flagged.
    autoSend: action.autoSend && Boolean(prompt),
    timestamp: Date.now(),
  };

  if (action.scope === 'selection') {
    const selectedText = info.selectionText?.trim();
    // Chrome only shows selection-scope items when there is a selection, so an
    // empty one means the page cleared it between click and dispatch. The page
    // context still makes the action meaningful, so we keep going.
    if (selectedText) pending.text = selectedText;
  } else if (action.scope === 'image') {
    if (info.srcUrl) pending.imageUrl = info.srcUrl;
  }

  await chrome.storage.session.set({ [CONTEXT_MENU_PENDING_KEY]: pending });
}

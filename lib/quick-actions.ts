/**
 * Quick action registry — the single source of truth for the right-click menu.
 *
 * Each entry describes one context-menu item: which right-click context it
 * appears in, which i18n keys hold its menu title and its chat prompt, and
 * whether it may be dispatched without the user pressing send.
 *
 * The registry is deliberately data-only (no `chrome.*`, no React), so the
 * background service worker, the side panel and the tests all consume the same
 * definitions. Adding an action means adding one entry here plus the two i18n
 * keys it names — nothing else needs to change.
 */

/**
 * Where the action draws its payload from. This maps 1:1 onto the
 * `chrome.contextMenus` contexts the item is registered for.
 */
export type QuickActionScope = 'page' | 'selection' | 'image';

export interface QuickActionDefinition {
  /** Stable id. Doubles as the `chrome.contextMenus` item id. */
  id: string;
  scope: QuickActionScope;
  /** i18n key for the menu item label, relative to `sidebar.contextMenu`. */
  titleKey: string;
  /**
   * i18n key for the prompt written into the chat input, relative to
   * `sidebar.quickActionPrompt`. Omitted for actions that only open the panel
   * and attach context without asking anything (e.g. plain "Ask Lumo").
   */
  promptKey?: string;
  /**
   * Whether this action may be sent automatically when a panel is idle.
   * Actions without a `promptKey` can never auto-send — there is no question to
   * ask — so this is only meaningful alongside one.
   */
  autoSend: boolean;
}

/**
 * Menu items in display order within their scope.
 *
 * Page-scope actions form a submenu under the extension's root entry; the
 * selection- and image-scope actions do too, so the top level of the user's
 * context menu only ever gains a single "Lumo" item per scope.
 */
export const QUICK_ACTIONS: readonly QuickActionDefinition[] = [
  // ─── Page scope ─────────────────────────────────────────────────────────
  {
    id: 'lumo-page-ask',
    scope: 'page',
    titleKey: 'ask',
    autoSend: false,
  },
  {
    id: 'lumo-page-summarize',
    scope: 'page',
    titleKey: 'summarizePage',
    promptKey: 'summarizePage',
    autoSend: true,
  },
  {
    id: 'lumo-page-translate',
    scope: 'page',
    titleKey: 'translatePage',
    promptKey: 'translatePage',
    autoSend: true,
  },
  {
    id: 'lumo-page-key-points',
    scope: 'page',
    titleKey: 'keyPointsPage',
    promptKey: 'keyPointsPage',
    autoSend: true,
  },
  {
    id: 'lumo-page-extract-data',
    scope: 'page',
    titleKey: 'extractDataPage',
    promptKey: 'extractDataPage',
    autoSend: true,
  },
  {
    id: 'lumo-page-explain',
    scope: 'page',
    titleKey: 'explainPage',
    promptKey: 'explainPage',
    autoSend: true,
  },

  // ─── Selection scope ────────────────────────────────────────────────────
  {
    id: 'lumo-selection-ask',
    scope: 'selection',
    titleKey: 'askSelection',
    autoSend: false,
  },
  {
    id: 'lumo-selection-translate',
    scope: 'selection',
    titleKey: 'translateSelection',
    promptKey: 'translateSelection',
    autoSend: true,
  },
  {
    id: 'lumo-selection-explain',
    scope: 'selection',
    titleKey: 'explainSelection',
    promptKey: 'explainSelection',
    autoSend: true,
  },
  {
    id: 'lumo-selection-summarize',
    scope: 'selection',
    titleKey: 'summarizeSelection',
    promptKey: 'summarizeSelection',
    autoSend: true,
  },

  // ─── Image scope ────────────────────────────────────────────────────────
  {
    id: 'lumo-image-ask',
    scope: 'image',
    titleKey: 'askImage',
    autoSend: false,
  },
  {
    id: 'lumo-image-describe',
    scope: 'image',
    titleKey: 'describeImage',
    promptKey: 'describeImage',
    autoSend: true,
  },
  {
    id: 'lumo-image-extract-text',
    scope: 'image',
    titleKey: 'extractTextImage',
    promptKey: 'extractTextImage',
    autoSend: true,
  },
];

/** Root parent menu id per scope, so each scope contributes one top-level item. */
export const QUICK_ACTION_PARENT_IDS: Record<QuickActionScope, string> = {
  page: 'lumo-root-page',
  selection: 'lumo-root-selection',
  image: 'lumo-root-image',
};

const ACTIONS_BY_ID = new Map(QUICK_ACTIONS.map((action) => [action.id, action]));

export function findQuickAction(id: string): QuickActionDefinition | undefined {
  return ACTIONS_BY_ID.get(id);
}

export function quickActionsForScope(scope: QuickActionScope): QuickActionDefinition[] {
  return QUICK_ACTIONS.filter((action) => action.scope === scope);
}

/** Full i18n path for an action's menu label. */
export function quickActionTitlePath(action: QuickActionDefinition): string {
  return `sidebar.contextMenu.${action.titleKey}`;
}

/** Full i18n path for an action's chat prompt, when it has one. */
export function quickActionPromptPath(action: QuickActionDefinition): string | undefined {
  return action.promptKey ? `sidebar.quickActionPrompt.${action.promptKey}` : undefined;
}

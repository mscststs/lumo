import { describe, it, expect } from 'vitest';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import {
  QUICK_ACTIONS,
  QUICK_ACTION_PARENT_IDS,
  findQuickAction,
  quickActionPromptPath,
  quickActionTitlePath,
  quickActionsForScope,
} from '@/lib/quick-actions';

/** Resolves a dotted path against a locale object, mirroring `context-menu.ts`. */
function resolve(locale: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], locale);
}

const LOCALES = { en, zh };

describe('quick action registry', () => {
  it('has unique ids', () => {
    const ids = QUICK_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never collides with the scope parent menu ids', () => {
    // A child sharing its parent's id would make `chrome.contextMenus.create`
    // throw and silently drop the rest of the menu.
    const parentIds = new Set(Object.values(QUICK_ACTION_PARENT_IDS));
    for (const action of QUICK_ACTIONS) {
      expect(parentIds.has(action.id)).toBe(false);
    }
  });

  it('resolves every action by id', () => {
    for (const action of QUICK_ACTIONS) {
      expect(findQuickAction(action.id)).toBe(action);
    }
    expect(findQuickAction('nope')).toBeUndefined();
  });

  it('covers every scope with at least one action', () => {
    // An empty scope would register a parent menu that can never be opened.
    for (const scope of ['page', 'selection', 'image'] as const) {
      expect(quickActionsForScope(scope).length).toBeGreaterThan(0);
    }
  });

  it('only flags actions that carry a prompt as auto-sendable', () => {
    // Auto-sending an action with no prompt would fire an empty request.
    for (const action of QUICK_ACTIONS) {
      if (action.autoSend) expect(action.promptKey).toBeTruthy();
    }
  });

  it.each(Object.entries(LOCALES))('has a menu title in %s for every action', (_name, locale) => {
    for (const action of QUICK_ACTIONS) {
      const title = resolve(locale, quickActionTitlePath(action));
      expect(typeof title, `missing title for ${action.id}`).toBe('string');
      expect(title).not.toBe('');
    }
  });

  it.each(Object.entries(LOCALES))('has a prompt in %s for every prompted action', (_name, locale) => {
    for (const action of QUICK_ACTIONS) {
      const path = quickActionPromptPath(action);
      if (!path) continue;
      const prompt = resolve(locale, path);
      expect(typeof prompt, `missing prompt for ${action.id}`).toBe('string');
      expect(prompt).not.toBe('');
    }
  });

  it.each(Object.entries(LOCALES))('has a root menu label in %s', (_name, locale) => {
    expect(typeof resolve(locale, 'sidebar.contextMenu.root')).toBe('string');
  });
});

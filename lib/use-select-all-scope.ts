import { useEffect } from 'react';

/**
 * Marker attribute for the element whose contents Ctrl/Cmd+A should select.
 *
 * Applied to the *content* root of a view — never to a wrapper that also holds
 * chrome (toolbars, gutters, labels). Only the first match in document order is
 * used, so a page must expose at most one visible root at a time.
 */
export const SELECT_ALL_ROOT_ATTR = 'data-select-all-root';

/** Props spread onto the element that owns the select-all scope. */
export const selectAllRootProps = { [SELECT_ALL_ROOT_ATTR]: '' } as const;

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Scope Ctrl/Cmd+A to the current view's content instead of the whole document.
 *
 * The browser default selects every text node on the page, so a "select all,
 * copy" on a source view drags the file name, MIME type and gutter line numbers
 * into the clipboard. `select-none` alone does not fix this: the nodes still sit
 * inside the document-wide range and remain visually highlighted.
 *
 * When no root is present (e.g. an iframe-rendered HTML preview owns its own
 * selection) the event is left untouched and the browser default applies.
 */
export function useSelectAllScope(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'a' && e.key !== 'A') return;
      // `metaKey` on macOS, `ctrlKey` elsewhere; any extra modifier means a
      // different shortcut that must not be swallowed.
      if (e.ctrlKey === e.metaKey || e.altKey || e.shiftKey) return;
      // Inside a text field, Ctrl+A means "select this field's value".
      if (isTextEntry(document.activeElement)) return;

      const root = document.querySelector(`[${SELECT_ALL_ROOT_ATTR}]`);
      const selection = window.getSelection();
      if (!root || !selection) return;

      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(root);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

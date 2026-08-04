/**
 * Element visibility for snapshots.
 *
 * jsdom implements no layout: `getBoundingClientRect()` always returns zeros and
 * `checkVisibility()` may be missing entirely. Testing spec §1.1 therefore calls
 * for a *pluggable* strategy — tests inject a style-only checker, production
 * uses the real geometry. Baking `getBoundingClientRect` into the traversal
 * would make every snapshot test assert on fabricated layout, which is worse
 * than not testing it at all.
 */

import { parentElementOrShadowHost } from './aria-roles';

export interface VisibilityStrategy {
  isVisible(element: Element): boolean;
  receivesPointerEvents(element: Element): boolean;
}

function computedStyleOf(element: Element): CSSStyleDeclaration | undefined {
  const view = element.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return undefined;
  try {
    return view.getComputedStyle(element);
  } catch {
    return undefined;
  }
}

/**
 * Style-only visibility: `display`, `visibility`, `hidden`, `aria-hidden`.
 * Shared by both strategies because it is the part that works everywhere.
 */
export function isStyleVisible(element: Element): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if ((element as HTMLElement).hidden) return false;
  if (element.tagName === 'INPUT' && element.getAttribute('type') === 'hidden') return false;

  for (let node: Element | undefined = element; node; node = parentElementOrShadowHost(node)) {
    if (node.getAttribute?.('aria-hidden') === 'true') return false;
    const style = computedStyleOf(node);
    if (!style) continue;
    if (style.display === 'none') return false;
    // `visibility` inherits, so an inherited `hidden` is caught at this node
    // anyway; checking the chain also covers engines that don't inherit it.
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

/**
 * Walk up looking for the first element with an explicit `pointer-events`.
 * Equivalent to Playwright's `roleUtils.ts:1235`.
 */
export function receivesPointerEventsByStyle(element: Element): boolean {
  for (let node: Element | undefined = element; node; node = parentElementOrShadowHost(node)) {
    const style = computedStyleOf(node);
    const value = style?.pointerEvents;
    if (!value) continue;
    if (value === 'none') return false;
    // Any other explicit value (auto, all, …) settles the question.
    return true;
  }
  return true;
}

/**
 * Production strategy: style checks plus real geometry. An element with a zero
 * box occupies no space and cannot be clicked, even if `display` says otherwise.
 */
export const layoutVisibility: VisibilityStrategy = {
  isVisible(element) {
    if (!isStyleVisible(element)) return false;
    // `checkVisibility` covers `content-visibility` and `opacity: 0` subtrees
    // that a manual style walk misses.
    const check = (element as Element & { checkVisibility?: (options?: unknown) => boolean })
      .checkVisibility;
    if (typeof check === 'function') {
      const visible = check.call(element, {
        checkOpacity: false,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
      if (!visible) return false;
    }
    const rect = element.getBoundingClientRect?.();
    if (!rect) return true;
    // A wrapper can legitimately have zero height while its children render,
    // so only leaf-ish elements are rejected on geometry alone.
    if (rect.width > 0 && rect.height > 0) return true;
    return element.childElementCount > 0;
  },
  receivesPointerEvents: receivesPointerEventsByStyle,
};

/**
 * Test strategy: style only. Everything laid out is treated as on-screen, which
 * is the best a layout-free DOM can honestly claim.
 */
export const styleOnlyVisibility: VisibilityStrategy = {
  isVisible: isStyleVisible,
  receivesPointerEvents: receivesPointerEventsByStyle,
};

/**
 * Pick a strategy from the environment.
 *
 * The probe is the document element's own box: a real engine reports the
 * viewport, jsdom reports zeros. Feature-detecting `checkVisibility` would be
 * indirect — a DOM shim could add it without implementing layout — whereas a
 * zero-size root *is* the definition of "no layout".
 */
export function defaultVisibilityStrategy(doc: Document): VisibilityStrategy {
  const rect = doc.documentElement?.getBoundingClientRect?.();
  const hasLayout = !!rect && rect.width > 0 && rect.height > 0;
  return hasLayout ? layoutVisibility : styleOnlyVisibility;
}

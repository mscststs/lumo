/**
 * Minimal ARIA role + accessible-name computation for page snapshots.
 *
 * This is a deliberate *subset* of Playwright's `roleUtils.ts` (1359 lines) —
 * see spec non-goal N1. It covers the roles and naming paths that actually show
 * up on mainstream pages; anything unmapped degrades to `generic`, which the
 * distiller then unwraps, so an unknown tag never hides its children.
 */

/** Tags that render nothing. Skipping them is what keeps SPA JSON blobs out. */
export const NON_RENDERED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'META',
  'LINK',
  'TITLE',
  'BASE',
]);

/**
 * Roles whose accessible name comes from their own text content.
 * Mirrors the ARIA `nameFrom: author, contents` set.
 */
const NAME_FROM_CONTENT_ROLES = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/** Roles an agent can plausibly act on. Drives ref allocation. */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** `<input type>` → implicit role. Unlisted types fall back to `textbox`. */
const INPUT_TYPE_ROLES: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  color: 'generic',
  date: 'generic',
  'datetime-local': 'generic',
  email: 'textbox',
  file: 'generic',
  hidden: 'none',
  image: 'button',
  month: 'generic',
  number: 'spinbutton',
  password: 'textbox',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  time: 'generic',
  url: 'textbox',
  week: 'generic',
};

/** Tag → implicit role for the tags that carry one unconditionally. */
const TAG_ROLES: Record<string, string> = {
  ARTICLE: 'article',
  ASIDE: 'complementary',
  BLOCKQUOTE: 'blockquote',
  BUTTON: 'button',
  CAPTION: 'caption',
  CODE: 'code',
  DD: 'definition',
  DEL: 'deletion',
  DFN: 'term',
  DIALOG: 'dialog',
  DL: 'list',
  DT: 'term',
  EM: 'emphasis',
  FIELDSET: 'group',
  FIGCAPTION: 'caption',
  FIGURE: 'figure',
  FOOTER: 'contentinfo',
  FORM: 'form',
  HEADER: 'banner',
  HGROUP: 'group',
  HR: 'separator',
  INS: 'insertion',
  LEGEND: 'caption',
  LI: 'listitem',
  MAIN: 'main',
  MARK: 'mark',
  MATH: 'math',
  MENU: 'list',
  METER: 'meter',
  NAV: 'navigation',
  OL: 'list',
  OPTGROUP: 'group',
  OPTION: 'option',
  OUTPUT: 'status',
  P: 'paragraph',
  PROGRESS: 'progressbar',
  SEARCH: 'search',
  STRONG: 'strong',
  SUB: 'subscript',
  SUP: 'superscript',
  // No ARIA role in HTML-AAM, but agents need to click it to expand a <details>.
  SUMMARY: 'button',
  TABLE: 'table',
  TBODY: 'rowgroup',
  TEXTAREA: 'textbox',
  TFOOT: 'rowgroup',
  THEAD: 'rowgroup',
  TIME: 'time',
  TR: 'row',
  UL: 'list',
};

/** Roles that must never reach the output; children are hoisted instead. */
const PRESENTATIONAL_ROLES = new Set(['none', 'presentation']);

export interface AriaRoleInfo {
  role: string;
  /** Heading level, only for `heading`. */
  level?: number;
}

/**
 * Resolve an element's role. An explicit `role` attribute always wins, matching
 * both the ARIA spec and Playwright.
 */
export function getAriaRole(element: Element): AriaRoleInfo {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) {
    if (explicit === 'heading') {
      return { role: 'heading', level: readAriaLevel(element) ?? 2 };
    }
    return { role: explicit };
  }

  const tag = element.tagName.toUpperCase();

  const headingMatch = /^H([1-6])$/.exec(tag);
  if (headingMatch) {
    return { role: 'heading', level: Number(headingMatch[1]) };
  }

  if (tag === 'A' || tag === 'AREA') {
    return { role: element.hasAttribute('href') ? 'link' : 'generic' };
  }

  if (tag === 'IMG') {
    // `alt=""` is the author explicitly marking the image decorative.
    const alt = element.getAttribute('alt');
    return { role: alt === '' ? 'none' : 'img' };
  }

  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).getAttribute('type')?.toLowerCase() ?? 'text';
    if (type === 'text' && element.hasAttribute('list')) return { role: 'combobox' };
    return { role: INPUT_TYPE_ROLES[type] ?? 'textbox' };
  }

  if (tag === 'SELECT') {
    const select = element as HTMLSelectElement;
    const multiple = select.hasAttribute('multiple');
    const size = Number(select.getAttribute('size') ?? '0');
    return { role: multiple || size > 1 ? 'listbox' : 'combobox' };
  }

  if (tag === 'TD') {
    return { role: 'cell' };
  }

  if (tag === 'TH') {
    const scope = element.getAttribute('scope');
    if (scope === 'row' || scope === 'rowgroup') return { role: 'rowheader' };
    return { role: 'columnheader' };
  }

  if (tag === 'SECTION') {
    // A landmark only when named — otherwise it is just a box.
    return { role: hasExplicitLabel(element) ? 'region' : 'generic' };
  }

  if (tag === 'DETAILS') {
    return { role: 'group' };
  }

  return { role: TAG_ROLES[tag] ?? 'generic' };
}

export function isPresentationalRole(role: string): boolean {
  return PRESENTATIONAL_ROLES.has(role);
}

function isNameFromContentRole(role: string): boolean {
  return NAME_FROM_CONTENT_ROLES.has(role);
}

function readAriaLevel(element: Element): number | undefined {
  const raw = element.getAttribute('aria-level');
  if (!raw) return undefined;
  const level = Number(raw);
  return Number.isFinite(level) ? level : undefined;
}

function hasExplicitLabel(element: Element): boolean {
  return (
    !!element.getAttribute('aria-label')?.trim() ||
    !!element.getAttribute('aria-labelledby')?.trim() ||
    !!element.getAttribute('title')?.trim()
  );
}

/** Collapse all whitespace runs and strip zero-width noise. */
export function normalizeWhiteSpace(text: string): string {
  return text
    .replace(/[\u200b\u00ad]/g, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/** `element.parentElement`, hopping out of shadow roots. */
export function parentElementOrShadowHost(element: Element): Element | undefined {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode() as ShadowRoot | Document | null;
  const host = (root as ShadowRoot | null)?.host;
  return host ?? undefined;
}

/** Root node used to resolve `aria-labelledby` / `label[for]` references. */
function referenceRoot(element: Element): Document | ShadowRoot {
  const root = element.getRootNode();
  return (root as ShadowRoot).host ? (root as ShadowRoot) : (element.ownerDocument as Document);
}

export interface AccessibleNameResult {
  name: string;
  /** True when the name was derived from the element's own text content. */
  fromContent: boolean;
}

/**
 * Compute an accessible name using the precedence the spec calls for:
 * aria-labelledby → aria-label → `<label>` → alt → title → placeholder →
 * text content (only for name-from-content roles).
 */
export function getAccessibleName(
  element: Element,
  role: string,
  textContentOf: (element: Element) => string,
): AccessibleNameResult {
  const labelledBy = element.getAttribute('aria-labelledby')?.trim();
  if (labelledBy) {
    const root = referenceRoot(element);
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById?.(id))
      .filter((node): node is HTMLElement => !!node)
      .map((node) => textContentOf(node));
    const name = normalizeWhiteSpace(parts.join(' '));
    if (name) return { name, fromContent: false };
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) {
    return { name: normalizeWhiteSpace(ariaLabel), fromContent: false };
  }

  const labelText = getLabelText(element, textContentOf);
  if (labelText) return { name: labelText, fromContent: false };

  const alt = element.getAttribute('alt');
  if (alt?.trim()) return { name: normalizeWhiteSpace(alt), fromContent: false };

  const title = element.getAttribute('title');
  if (title?.trim()) return { name: normalizeWhiteSpace(title), fromContent: false };

  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) return { name: normalizeWhiteSpace(placeholder), fromContent: false };

  if (isNameFromContentRole(role)) {
    const name = normalizeWhiteSpace(textContentOf(element));
    if (name) return { name, fromContent: true };
  }

  return { name: '', fromContent: false };
}

/** `<label for>` and ancestor-`<label>` naming, plus `<fieldset><legend>`. */
function getLabelText(element: Element, textContentOf: (element: Element) => string): string {
  const tag = element.tagName.toUpperCase();
  const labelable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'METER' || tag === 'OUTPUT' || tag === 'PROGRESS';

  if (labelable) {
    const id = element.getAttribute('id');
    if (id) {
      const root = referenceRoot(element);
      // `querySelectorAll` rather than `labels` so shadow roots work uniformly.
      const labels = root.querySelectorAll?.(`label[for="${cssEscape(id)}"]`);
      const text = normalizeWhiteSpace(
        Array.from(labels ?? [])
          .map((label) => textContentOf(label))
          .join(' '),
      );
      if (text) return text;
    }
    const wrapping = element.closest?.('label');
    if (wrapping) {
      const text = normalizeWhiteSpace(textContentOf(wrapping));
      if (text) return text;
    }
  }

  if (tag === 'FIELDSET') {
    const legend = element.querySelector?.(':scope > legend');
    if (legend) return normalizeWhiteSpace(textContentOf(legend));
  }

  if (tag === 'TABLE' || tag === 'FIGURE') {
    const caption = element.querySelector?.(
      tag === 'TABLE' ? ':scope > caption' : ':scope > figcaption',
    );
    if (caption) return normalizeWhiteSpace(textContentOf(caption));
  }

  return '';
}

/** Minimal CSS.escape shim — attribute selectors only need quote handling. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

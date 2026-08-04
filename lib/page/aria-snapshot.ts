/**
 * ARIA snapshot: DOM → role/name tree → distiller → YAML-ish text.
 *
 * Ported from Playwright's `ariaSnapshot.ts` + `ariaSnapshotDistiller.ts`, kept
 * to the subset that mainstream pages need (spec non-goal N1).
 *
 * Three properties matter and each fixes a measured defect:
 *  - block-level elements get whitespace between them, so `NewsProducts` can no
 *    longer come out glued (defect A);
 *  - non-rendered tags are skipped, so a `<script type="application/json">`
 *    state blob never reaches the output (defect A);
 *  - nothing is cut by DOM depth. Wrapper `generic` nodes are unwrapped by
 *    semantics instead, so 18 levels of Tailwind divs collapse to one and deep
 *    content stops disappearing (defect B).
 */

import {
  NON_RENDERED_TAGS,
  INTERACTIVE_ROLES,
  getAccessibleName,
  getAriaRole,
  isPresentationalRole,
  normalizeWhiteSpace,
} from './aria-roles';
import { refFor, pruneRefs } from './ref-registry';
import {
  defaultVisibilityStrategy,
  type VisibilityStrategy,
} from './visibility';

export interface AriaNode {
  role: string;
  name: string;
  /** Mixed element / raw-text children; strings are merged by the distiller. */
  children: Array<AriaNode | string>;
  /** Extra rendered properties, e.g. `url`, `placeholder`. */
  props: Record<string, string>;
  ref?: string;
  element: Element;
  visible: boolean;
  receivesPointerEvents: boolean;
  /** True when `name` came from the element's own text content. */
  nameFromContent: boolean;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  /** Value of a form control. */
  value?: string;
}

export interface SnapshotOptions {
  root?: Element;
  /** Emit only nodes an agent can act on (plus their structural ancestors). */
  interactiveOnly?: boolean;
  /** Output-only truncation. Does NOT drive traversal — see spec §5 D3. */
  depth?: number;
  visibility?: VisibilityStrategy;
  /** Allocate refs. Disabled by pure-structure tests. */
  assignRefs?: boolean;
}

export interface SnapshotResult {
  snapshot: string;
  root: AriaNode;
  refCount: number;
}

// ============================================================================
// Tree building
// ============================================================================

/** Build the raw (un-distilled) tree. Exposed for tests and `page_find`. */
export function buildAriaTree(doc: Document, options: SnapshotOptions = {}): AriaNode {
  const visibility = options.visibility ?? defaultVisibilityStrategy(doc);
  const assignRefs = options.assignRefs ?? true;
  const rootElement = options.root ?? doc.body ?? doc.documentElement;

  const textCache = new Map<Element, string>();
  /** Accessible-name text, honouring visibility so hidden labels stay out. */
  const textContentOf = (element: Element): string => {
    const cached = textCache.get(element);
    if (cached !== undefined) return cached;
    const text = collectText(element, visibility);
    textCache.set(element, text);
    return text;
  };

  const makeNode = (element: Element): AriaNode => {
    const { role, level } = getAriaRole(element);
    const { name, fromContent } = getAccessibleName(element, role, textContentOf);
    const node: AriaNode = {
      role,
      name,
      children: [],
      props: {},
      element,
      visible: visibility.isVisible(element),
      receivesPointerEvents: visibility.receivesPointerEvents(element),
      nameFromContent: fromContent,
      level,
    };
    applyStateAndProps(node, element);
    if (assignRefs) assignRef(node);
    return node;
  };

  const root = makeNode(rootElement);

  const visit = (parent: AriaNode, node: Node): void => {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      const text = node.nodeValue ?? '';
      // Keep raw whitespace here: the distiller needs to know a separator
      // existed before it merges siblings.
      if (text) parent.children.push(text);
      return;
    }
    if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) return;

    const element = node as Element;
    if (NON_RENDERED_TAGS.has(element.tagName.toUpperCase())) return;

    const slotted = element.tagName === 'SLOT'
      ? (element as HTMLSlotElement).assignedNodes?.() ?? []
      : [];
    // A <slot> itself renders nothing: recurse into what was assigned to it.
    if (element.tagName === 'SLOT') {
      if (slotted.length) {
        for (const child of slotted) visit(parent, child);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          visit(parent, child);
        }
      }
      return;
    }

    const visible = defaultIsVisible(element, visibility);
    // Hidden subtrees are dropped wholesale — this is what keeps a
    // `display:none` "Ghost button" out of the snapshot.
    if (!visible) return;

    const child = makeNode(element);
    if (isPresentationalRole(child.role)) {
      // role=presentation / none: the element vanishes, its children do not.
      descend(parent, element, visibility, visit);
      return;
    }

    const style = computedDisplay(element);
    const treatAsBlock = style !== 'inline' && style !== 'inline-block' ? ' ' : '';
    const isBr = element.tagName === 'BR';

    if (treatAsBlock || isBr) parent.children.push(' ');
    parent.children.push(child);
    descend(child, element, visibility, visit);
    if (treatAsBlock || isBr) parent.children.push(' ');
  };

  descend(root, rootElement, visibility, visit);

  if (assignRefs) pruneRefs();
  return root;
}

/** Recurse into light DOM children plus any shadow root, skipping slotted dupes. */
function descend(
  parent: AriaNode,
  element: Element,
  _visibility: VisibilityStrategy,
  visit: (parent: AriaNode, node: Node) => void,
): void {
  for (let child = element.firstChild; child; child = child.nextSibling) {
    // A slotted node is rendered at its <slot>, not here; visiting both would
    // duplicate it.
    if ((child as Element).assignedSlot) continue;
    visit(parent, child);
  }
  if (element.shadowRoot) {
    for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) {
      visit(parent, child);
    }
  }
}

function defaultIsVisible(element: Element, visibility: VisibilityStrategy): boolean {
  return visibility.isVisible(element);
}

function computedDisplay(element: Element): string {
  const view = element.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return blockByDefault(element) ? 'block' : 'inline';
  try {
    const display = view.getComputedStyle(element).display;
    if (display) return display;
  } catch {
    /* fall through to the tag heuristic */
  }
  return blockByDefault(element) ? 'block' : 'inline';
}

/**
 * Fallback for environments without a style engine. jsdom *does* have
 * `getComputedStyle`, but it returns '' for `display` on unstyled elements, so
 * the block/inline distinction that prevents glued text needs this table.
 */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM',
  'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
  'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'IMG', 'PICTURE',
  'BUTTON', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA', 'OBJECT', 'OUTPUT',
]);

function blockByDefault(element: Element): boolean {
  return !INLINE_TAGS.has(element.tagName.toUpperCase());
}

/** Visible text of an element, used for accessible names. */
function collectText(element: Element, visibility: VisibilityStrategy): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (NON_RENDERED_TAGS.has(el.tagName.toUpperCase())) return;
    if (!visibility.isVisible(el)) return;
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt) parts.push(` ${alt} `);
      return;
    }
    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      const type = input.getAttribute('type');
      if (type === 'submit' || type === 'button' || type === 'reset') {
        parts.push(` ${input.value ?? ''} `);
      }
      return;
    }
    if (el.tagName === 'SLOT') {
      const assigned = (el as HTMLSlotElement).assignedNodes?.() ?? [];
      for (const child of assigned) walk(child);
      return;
    }
    if (blockByDefault(el)) parts.push(' ');
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if ((child as Element).assignedSlot) continue;
      walk(child);
    }
    if (el.shadowRoot) {
      for (let child = el.shadowRoot.firstChild; child; child = child.nextSibling) walk(child);
    }
    if (blockByDefault(el)) parts.push(' ');
  };
  walk(element);
  return normalizeWhiteSpace(parts.join(''));
}

/** State attributes plus the `/url`-style props Playwright renders. */
function applyStateAndProps(node: AriaNode, element: Element): void {
  const tag = element.tagName.toUpperCase();

  if (node.role === 'link') {
    const href = element.getAttribute('href');
    if (href) node.props.url = href;
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder && (node.role === 'textbox' || node.role === 'searchbox' || node.role === 'combobox')) {
    node.props.placeholder = placeholder;
  }

  if (element.hasAttribute('aria-disabled')) {
    node.disabled = element.getAttribute('aria-disabled') === 'true';
  } else if ((element as HTMLInputElement).disabled) {
    node.disabled = true;
  }

  const ariaChecked = element.getAttribute('aria-checked');
  if (ariaChecked) {
    node.checked = ariaChecked === 'mixed' ? 'mixed' : ariaChecked === 'true';
  } else if (tag === 'INPUT') {
    const input = element as HTMLInputElement;
    const type = input.getAttribute('type');
    if (type === 'checkbox' || type === 'radio') {
      node.checked = input.indeterminate ? 'mixed' : input.checked;
    }
  }

  const ariaExpanded = element.getAttribute('aria-expanded');
  if (ariaExpanded) node.expanded = ariaExpanded === 'true';
  else if (tag === 'DETAILS') node.expanded = (element as HTMLDetailsElement).open;

  const ariaSelected = element.getAttribute('aria-selected');
  if (ariaSelected) node.selected = ariaSelected === 'true';
  else if (tag === 'OPTION') node.selected = (element as HTMLOptionElement).selected;

  if (node.level === undefined && element.hasAttribute('aria-level')) {
    const level = Number(element.getAttribute('aria-level'));
    if (Number.isFinite(level)) node.level = level;
  }

  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const value = (element as HTMLInputElement).value;
    if (value) node.value = value;
  }
}

/**
 * Only interactable elements get a ref — a ref the agent cannot act on is pure
 * token waste. Mirrors Playwright's `refs: 'interactable'`.
 */
function assignRef(node: AriaNode): void {
  if (!node.visible || !node.receivesPointerEvents) return;
  if (!isRefWorthy(node)) return;
  node.ref = refFor(node.element);
}

function isRefWorthy(node: AriaNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  const element = node.element;
  if (element.hasAttribute('onclick') || element.hasAttribute('tabindex')) return true;
  // A cursor:pointer box is almost always a hand-rolled button.
  const view = element.ownerDocument?.defaultView;
  if (view?.getComputedStyle) {
    try {
      if (view.getComputedStyle(element).cursor === 'pointer') return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

// ============================================================================
// Distiller
// ============================================================================

type PluginResult = 'remove' | 'unwrap' | void;

interface DistillerContext {
  /** Node → its parent, so plugins can look upward. */
  parents: Map<AriaNode, AriaNode | undefined>;
  /** Names already emitted by an ancestor, for redundant-name removal. */
  ancestorNames: string[];
}

interface DistillerPlugin {
  name: string;
  enter?(node: AriaNode, ctx: DistillerContext): PluginResult;
  exit?(node: AriaNode, ctx: DistillerContext): PluginResult;
}

/**
 * Merge adjacent text children, normalise whitespace and drop empties.
 *
 * This is the fix for defect A: without a separator between block children the
 * old snapshot produced `NewsProductsPricingDocs`. Whitespace-only strings
 * survive merging as a single space precisely so they keep words apart.
 */
const mergeStringChildren: DistillerPlugin = {
  name: 'mergeStringChildren',
  exit(node) {
    const merged: Array<AriaNode | string> = [];
    for (const child of node.children) {
      if (typeof child !== 'string') {
        merged.push(child);
        continue;
      }
      const previous = merged[merged.length - 1];
      if (typeof previous === 'string') {
        merged[merged.length - 1] = previous + child;
      } else {
        merged.push(child);
      }
    }
    node.children = merged
      .map((child) => (typeof child === 'string' ? normalizeWhiteSpace(child) : child))
      .filter((child) => typeof child !== 'string' || child.length > 0);

    // A lone text child identical to the node's own name is pure duplication.
    if (
      node.children.length === 1 &&
      typeof node.children[0] === 'string' &&
      node.children[0] === node.name
    ) {
      node.children = [];
    }
  },
};

/** Decorative images: no name, no content, not the thing you would click. */
const removeNamelessImages: DistillerPlugin = {
  name: 'removeNamelessImages',
  exit(node, ctx) {
    if (node.role !== 'img' && node.role !== 'image') return;
    if (node.name || node.children.length) return;
    // An icon-only button rendered as a bare <img> must survive.
    if (isClickTargetRoot(node, ctx)) return;
    return 'remove';
  },
};

/**
 * Clear a content-derived name when the contributing children are still in the
 * output — otherwise every heading and link prints its text twice.
 */
const removeRedundantNames: DistillerPlugin = {
  name: 'removeRedundantNames',
  enter(node, ctx) {
    if (node.name) ctx.ancestorNames.push(node.name);
  },
  exit(node, ctx) {
    if (node.name) ctx.ancestorNames.pop();
    if (!node.name || !node.nameFromContent) return;
    const rendered = node.children.filter((child) => typeof child !== 'string').length;
    // Keep the name when it is the node's only representation of its text.
    if (rendered === 0) return;
    const childText = node.children
      .map((child) => (typeof child === 'string' ? child : child.name))
      .filter(Boolean)
      .join(' ');
    if (normalizeWhiteSpace(childText) === node.name) node.name = '';
  },
};

/** `generic: - generic: "text"` → `generic: "text"`. */
const inlineTextIntoGeneric: DistillerPlugin = {
  name: 'inlineTextIntoGeneric',
  exit(node) {
    if (node.role !== 'generic' || node.name) return;
    if (node.children.length !== 1) return;
    const only = node.children[0];
    if (!only || typeof only === 'string') return;
    if (only.role !== 'generic' || only.name || only.ref) return;
    if (only.children.length !== 1 || typeof only.children[0] !== 'string') return;
    node.children = only.children;
  },
};

/**
 * Unwrap semantically empty wrappers. This is the replacement for `maxDepth`:
 * 18 nested divs collapse bottom-up into one level, so depth stops mattering
 * (defect B).
 */
const unwrapSingleChildGenerics: DistillerPlugin = {
  name: 'unwrapSingleChildGenerics',
  exit(node, ctx) {
    if (node.role !== 'generic' || node.name) return;
    if (node.children.length > 1) return;
    // A wrapper that is itself the click target carries the ref; unwrapping it
    // would throw the ref away.
    if (node.ref) return;
    if (!node.children.length && isClickTargetRoot(node, ctx)) return;
    return 'unwrap';
  },
};

/** `link "Docs" > text "Docs"` — the child adds nothing. */
const removeNameRepeatingChild: DistillerPlugin = {
  name: 'removeNameRepeatingChild',
  exit(node) {
    if (!node.name) return;
    node.children = node.children.filter((child) => {
      if (typeof child === 'string') return child !== node.name;
      if (child.ref || child.children.length || Object.keys(child.props).length) return true;
      return child.name !== node.name;
    });
  },
};

function isClickTargetRoot(node: AriaNode, ctx: DistillerContext): boolean {
  if (node.ref) return true;
  const parent = ctx.parents.get(node);
  return !!parent?.ref;
}

/**
 * Plugin order is load-bearing:
 *  1. text must be merged before anything reasons about children;
 *  2. redundant names must be cleared before generics are judged "nameless";
 *  3. unwrapping runs last so it sees the final child counts.
 */
const PLUGINS: DistillerPlugin[] = [
  mergeStringChildren,
  removeNamelessImages,
  removeRedundantNames,
  removeNameRepeatingChild,
  inlineTextIntoGeneric,
  unwrapSingleChildGenerics,
];

export function distill(root: AriaNode): AriaNode {
  const ctx: DistillerContext = { parents: new Map(), ancestorNames: [] };
  ctx.parents.set(root, undefined);
  runPlugins(root, ctx);
  return root;
}

/**
 * Single-pass visitor over the tree, applying every plugin's `enter` on the way
 * down and `exit` on the way up. Equivalent to `ariaSnapshotDistiller.ts:55-99`.
 */
function runPlugins(node: AriaNode, ctx: DistillerContext): PluginResult {
  for (const plugin of PLUGINS) {
    const result = plugin.enter?.(node, ctx);
    if (result) {
      // Balance the enter/exit pairing of any plugin that pushed state.
      for (const other of PLUGINS) other.exit?.(node, ctx);
      return result;
    }
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    if (typeof child === 'string') continue;
    ctx.parents.set(child, node);
    const result = runPlugins(child, ctx);
    if (result === 'remove') {
      node.children.splice(i, 1);
      i--;
    } else if (result === 'unwrap') {
      node.children.splice(i, 1, ...child.children);
      // Re-visit the spliced-in children in place: an unwrapped chain must
      // collapse fully, not one level per pass.
      i--;
    }
  }

  for (const plugin of PLUGINS) {
    const result = plugin.exit?.(node, ctx);
    if (result) return result;
  }
  return undefined;
}

// ============================================================================
// Rendering
// ============================================================================

/** Roles that carry no information once they have no name and no state. */
const OMITTED_WRAPPER_ROLES = new Set(['generic', 'none', 'presentation']);

export function renderAriaTree(root: AriaNode, options: { depth?: number } = {}): string {
  const lines: string[] = [];
  const maxDepth = options.depth && options.depth > 0 ? options.depth : Infinity;

  const renderChildren = (node: AriaNode, indent: string, depth: number): void => {
    if (depth > maxDepth) {
      if (node.children.length) lines.push(`${indent}- …`);
      return;
    }
    for (const child of node.children) {
      if (typeof child === 'string') {
        lines.push(`${indent}- text: ${child}`);
        continue;
      }
      renderNode(child, indent, depth);
    }
  };

  const renderNode = (node: AriaNode, indent: string, depth: number): void => {
    // A nameless wrapper contributes nothing but indentation.
    if (OMITTED_WRAPPER_ROLES.has(node.role) && !node.name && !node.ref && !hasState(node)) {
      renderChildren(node, indent, depth);
      return;
    }

    let line = `${indent}- ${node.role}`;
    if (node.name) line += ` ${JSON.stringify(node.name)}`;
    for (const attr of stateAttributes(node)) line += ` [${attr}]`;
    if (node.ref) line += ` [ref=${node.ref}]`;

    const propEntries = Object.entries(node.props);
    const hasBody = propEntries.length > 0 || node.children.length > 0;
    lines.push(hasBody ? `${line}:` : line);

    const childIndent = `${indent}  `;
    for (const [key, value] of propEntries) {
      lines.push(`${childIndent}- /${key}: ${value}`);
    }
    renderChildren(node, childIndent, depth + 1);
  };

  renderChildren(root, '', 1);
  return lines.join('\n');
}

function hasState(node: AriaNode): boolean {
  return stateAttributes(node).length > 0;
}

function stateAttributes(node: AriaNode): string[] {
  const attrs: string[] = [];
  if (node.level !== undefined) attrs.push(`level=${node.level}`);
  if (node.checked !== undefined) {
    attrs.push(node.checked === 'mixed' ? 'checked=mixed' : node.checked ? 'checked' : 'unchecked');
  }
  if (node.disabled) attrs.push('disabled');
  if (node.expanded !== undefined) attrs.push(node.expanded ? 'expanded' : 'collapsed');
  if (node.selected) attrs.push('selected');
  return attrs;
}

// ============================================================================
// Entry point
// ============================================================================

/** Keep a node when it, or anything under it, can be acted on. */
function pruneToInteractive(node: AriaNode): boolean {
  node.children = node.children.filter((child) => {
    if (typeof child === 'string') return false;
    return pruneToInteractive(child);
  });
  return !!node.ref || node.children.length > 0;
}

export function captureAriaSnapshot(doc: Document, options: SnapshotOptions = {}): SnapshotResult {
  const root = buildAriaTree(doc, options);
  distill(root);
  if (options.interactiveOnly) pruneToInteractive(root);
  return {
    snapshot: renderAriaTree(root, { depth: options.depth }),
    root,
    refCount: countRefs(root),
  };
}

export function countRefs(node: AriaNode): number {
  let total = node.ref ? 1 : 0;
  for (const child of node.children) {
    if (typeof child !== 'string') total += countRefs(child);
  }
  return total;
}

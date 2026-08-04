/**
 * Request dispatch for the page content script.
 *
 * Split out of `entrypoints/content.ts` so the heavy modules (Readability +
 * Turndown, ~32KB gzip) live in a lazily imported chunk: a tab the user never
 * asks about pays for the message listener only.
 */

import { captureAriaSnapshot } from './aria-snapshot';
import { extractContent } from './extract-content';
import { findInAriaTree } from './find';
import { applyOutputLimit } from './output-limit';
import { resolveRef } from './ref-registry';
import { getAriaRole, getAccessibleName, normalizeWhiteSpace } from './aria-roles';
import type {
  PageActRequest,
  PageElementInfo,
  PageFindRequest,
  PageReadRequest,
  PageRequest,
  PageResolveRefRequest,
  PageResponse,
  PageSnapshotRequest,
} from './messages';

export async function handlePageRequest(request: PageRequest): Promise<PageResponse> {
  switch (request.type) {
    case 'lumo:page:read':
      return handleRead(request);
    case 'lumo:page:snapshot':
      return handleSnapshot(request);
    case 'lumo:page:find':
      return handleFind(request);
    case 'lumo:page:resolve-ref':
      return handleResolveRef(request);
    case 'lumo:page:act':
      return handleAct(request);
    default: {
      // Compile-time exhaustiveness: a new request type must be handled here.
      const exhaustive: never = request;
      return { ok: false, error: `Unknown page request: ${JSON.stringify(exhaustive)}` };
    }
  }
}

function handleRead(request: PageReadRequest): PageResponse {
  const result = extractContent({
    doc: document,
    mode: request.mode,
    selector: request.selector,
    includeImages: request.includeImages,
    includeLinks: request.includeLinks,
  });
  if ('error' in result) return { ok: false, error: result.error };

  const { text, limit } = applyOutputLimit(result.markdown, request);
  return {
    ok: true,
    url: location.href,
    title: result.title || document.title,
    resolvedMode: result.resolvedMode,
    byline: result.byline,
    excerpt: result.excerpt,
    siteName: result.siteName,
    publishedTime: result.publishedTime,
    lang: result.lang || document.documentElement.lang || undefined,
    markdown: text,
    limit,
  };
}

function handleSnapshot(request: PageSnapshotRequest): PageResponse {
  let root: Element | undefined;
  if (request.selector) {
    const found = document.querySelector(request.selector);
    if (!found) return { ok: false, error: `Element not found: ${request.selector}` };
    root = found;
  }

  const result = captureAriaSnapshot(document, {
    root,
    depth: request.depth,
    interactiveOnly: request.interactiveOnly,
  });
  const { text, limit } = applyOutputLimit(result.snapshot, request);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    snapshot: text,
    refCount: result.refCount,
    limit,
  };
}

function handleFind(request: PageFindRequest): PageResponse {
  const result = findInAriaTree(document, {
    text: request.text,
    regex: request.regex,
    context: request.context,
  });
  if ('error' in result) return { ok: false, error: result.error };

  // Matches are rendered as text before limiting so paging stays meaningful.
  const rendered = result.matches
    .map((match) => [match.path ? `# ${match.path}` : '#', ...match.lines].join('\n'))
    .join('\n\n');
  const { limit } = applyOutputLimit(rendered, request);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    matches: result.matches,
    totalMatches: result.totalMatches,
    limit,
  };
}

function handleResolveRef(request: PageResolveRefRequest): PageResponse {
  const element = resolveRef(request.ref);
  if (!element) return { ok: false, error: staleRefError(request.ref) };
  return { ok: true, element: describeElement(request.ref, element) };
}

/**
 * Act on a ref'd element.
 *
 * The only correctness rule that matters: an unresolvable ref fails loudly.
 * Falling back to "a similar element" is what makes an agent corrupt data
 * silently (spec defect C).
 */
function handleAct(request: PageActRequest): PageResponse {
  const element = resolveRef(request.ref);
  if (!element) return { ok: false, error: staleRefError(request.ref) };

  const html = element as HTMLElement;
  const info = describeElement(request.ref, element);

  switch (request.action) {
    case 'click': {
      html.scrollIntoView?.({ block: 'center' });
      html.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      html.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      html.click();
      return { ok: true, action: 'click', ref: request.ref, element: info };
    }
    case 'hover': {
      html.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      html.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { ok: true, action: 'hover', ref: request.ref, element: info };
    }
    case 'focus': {
      html.focus?.();
      return { ok: true, action: 'focus', ref: request.ref, element: info };
    }
    case 'fill': {
      const value = request.value ?? '';
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      if (!isFillable(element)) {
        return { ok: false, error: `Element is not fillable: <${info.tag}>` };
      }
      field.focus?.();
      setNativeValue(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, action: 'fill', ref: request.ref, element: info, value };
    }
    case 'select-option': {
      const select = element as HTMLSelectElement;
      if (select.tagName !== 'SELECT') {
        return { ok: false, error: `Element is not a select: <${info.tag}>` };
      }
      const value = request.value ?? '';
      const option = Array.from(select.options).find((o) => o.value === value || o.text === value);
      if (!option) return { ok: false, error: `Option not found: ${value}` };
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, action: 'select-option', ref: request.ref, element: info, value: select.value };
    }
    case 'check-checkbox': {
      const input = element as HTMLInputElement;
      const type = input.getAttribute('type');
      if (input.tagName !== 'INPUT' || (type !== 'checkbox' && type !== 'radio')) {
        return { ok: false, error: `Element is not a checkbox/radio: <${info.tag}>` };
      }
      const next = request.checked === null || request.checked === undefined
        ? !input.checked
        : request.checked;
      input.checked = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, action: 'check-checkbox', ref: request.ref, element: info, checked: input.checked };
    }
    default: {
      const exhaustive: never = request.action;
      return { ok: false, error: `Unknown action: ${String(exhaustive)}` };
    }
  }
}

function staleRefError(ref: string): string {
  return `Element ref "${ref}" is no longer on the page. The DOM changed since the snapshot was taken — call page_snapshot again to get a fresh ref.`;
}

function isFillable(element: Element): boolean {
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return true;
  return (element as HTMLElement).isContentEditable === true;
}

/** Bypass React's controlled-input guard by going through the native setter. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element.tagName === 'TEXTAREA'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

export function describeElement(ref: string, element: Element): PageElementInfo {
  const { role } = getAriaRole(element);
  const { name } = getAccessibleName(element, role, (el) =>
    normalizeWhiteSpace(el.textContent ?? ''),
  );
  const input = element as HTMLInputElement;
  return {
    ref,
    tag: element.tagName.toLowerCase(),
    role,
    name,
    text: normalizeWhiteSpace(element.textContent ?? '').slice(0, 200) || undefined,
    value: typeof input.value === 'string' && input.value ? input.value : undefined,
    checked: typeof input.checked === 'boolean' ? input.checked : undefined,
    disabled: input.disabled === true ? true : undefined,
  };
}

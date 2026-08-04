/**
 * Messaging protocol between the tool layer (side panel) and the page content
 * script. Mirrors the shape of `webmcp-messages.ts`: a hand-written
 * discriminated union keyed by a namespaced `type`.
 *
 * Unlike the WebMCP bridge there is no MAIN-world hop — everything runs in the
 * ISOLATED world, so a single chrome.tabs.sendMessage round trip is enough.
 */

/** Namespace every message shares, used to ignore foreign messages cheaply. */
export const PAGE_MESSAGE_PREFIX = 'lumo:page:';

export type PageReadMode = 'auto' | 'article' | 'full';

/** Output limit applied to every text-producing request. See spec §6.5. */
export interface PageOutputLimit {
  maxChars?: number;
  offset?: number;
}

export interface PageReadRequest extends PageOutputLimit {
  type: 'lumo:page:read';
  mode: PageReadMode;
  selector?: string;
  includeImages: boolean;
  includeLinks: boolean;
}

export interface PageSnapshotRequest extends PageOutputLimit {
  type: 'lumo:page:snapshot';
  selector?: string;
  /** Output-only truncation. Does NOT drive traversal — see spec §5 D3. */
  depth?: number;
  interactiveOnly: boolean;
}

export interface PageFindRequest extends PageOutputLimit {
  type: 'lumo:page:find';
  text?: string;
  regex?: string;
  context: number;
}

/** Resolve a snapshot ref back to a live element and describe it. */
export interface PageResolveRefRequest {
  type: 'lumo:page:resolve-ref';
  ref: string;
}

/** Everything an action can be asked to do against a ref. */
export type PageActAction =
  | 'click'
  | 'fill'
  | 'hover'
  | 'focus'
  | 'select-option'
  | 'check-checkbox';

/**
 * Act on a ref'd element. The ref path deliberately lives here rather than in
 * `executeScript`, because the registry that owns element identity is in the
 * content script.
 */
export interface PageActRequest {
  type: 'lumo:page:act';
  action: PageActAction;
  ref: string;
  /** `fill` / `select-option` payload. */
  value?: string;
  /** `check-checkbox` target state; `null` toggles. */
  checked?: boolean | null;
}

export type PageRequest =
  | PageReadRequest
  | PageSnapshotRequest
  | PageFindRequest
  | PageResolveRefRequest
  | PageActRequest;

export interface PageOutputLimitMeta {
  totalChars: number;
  returnedChars: number;
  offset: number;
  truncated: boolean;
}

export interface PageReadResponse {
  ok: true;
  url: string;
  title: string;
  /** Which mode actually ran — `auto` resolves to `article` or `full`. */
  resolvedMode: 'article' | 'full';
  byline?: string;
  excerpt?: string;
  siteName?: string;
  publishedTime?: string;
  lang?: string;
  markdown: string;
  limit: PageOutputLimitMeta;
}

export interface PageSnapshotResponse {
  ok: true;
  url: string;
  title: string;
  /** YAML-ish tree, Playwright aria-snapshot format. */
  snapshot: string;
  refCount: number;
  limit: PageOutputLimitMeta;
}

export interface PageFindMatch {
  /** Roles from the tree root down to the match, e.g. `main > list > listitem`. */
  path: string;
  lines: string[];
  ref?: string;
}

export interface PageFindResponse {
  ok: true;
  url: string;
  title: string;
  matches: PageFindMatch[];
  totalMatches: number;
  limit: PageOutputLimitMeta;
}

export interface PageElementInfo {
  ref: string;
  tag: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface PageResolveRefResponse {
  ok: true;
  element: PageElementInfo;
}

export interface PageActResponse {
  ok: true;
  action: PageActAction;
  ref: string;
  element: PageElementInfo;
  /** Populated by `fill` / `select-option` / `check-checkbox`. */
  value?: string;
  checked?: boolean;
}

export interface PageErrorResponse {
  ok: false;
  error: string;
}

export type PageResponse =
  | PageReadResponse
  | PageSnapshotResponse
  | PageFindResponse
  | PageResolveRefResponse
  | PageActResponse
  | PageErrorResponse;

/** Narrow an unknown `chrome.runtime` payload to one of our requests. */
export function isPageRequest(value: unknown): value is PageRequest {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith(PAGE_MESSAGE_PREFIX);
}

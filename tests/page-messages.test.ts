/**
 * @vitest-environment jsdom
 *
 * Messaging protocol contract.
 *
 * The content script shares `chrome.runtime.onMessage` with the WebMCP bridge, so
 * the namespace check is what keeps the two from eating each other's traffic. The
 * exhaustiveness check is compile-time; asserting it at runtime as well means a
 * newly added request type cannot ship as a silent no-op.
 */

import { describe, expect, it } from 'vitest';
import { isPageRequest, PAGE_MESSAGE_PREFIX, type PageRequest } from '@/lib/page/messages';
import { handlePageRequest } from '@/lib/page/handlers';

/** One representative of every member of the request union. */
const ALL_REQUESTS: PageRequest[] = [
  { type: 'lumo:page:read', mode: 'auto', includeImages: true, includeLinks: true },
  { type: 'lumo:page:snapshot', interactiveOnly: false },
  { type: 'lumo:page:find', text: 'anything', context: 2 },
  { type: 'lumo:page:resolve-ref', ref: 'e1' },
  { type: 'lumo:page:act', action: 'click', ref: 'e1' },
];

describe('page message protocol', () => {
  it('namespaces every request type under lumo:page:', () => {
    for (const request of ALL_REQUESTS) {
      expect(request.type.startsWith(PAGE_MESSAGE_PREFIX)).toBe(true);
    }
  });

  it('accepts every member of the request union', () => {
    for (const request of ALL_REQUESTS) {
      expect(isPageRequest(request)).toBe(true);
    }
  });

  it('rejects foreign and malformed messages', () => {
    // WebMCP traffic shares the same listener; misclassifying it would break both.
    expect(isPageRequest({ type: 'webmcp:tools-report' })).toBe(false);
    expect(isPageRequest({ type: 'lumo:other:thing' })).toBe(false);
    expect(isPageRequest({ noType: true })).toBe(false);
    expect(isPageRequest({ type: 42 })).toBe(false);
    expect(isPageRequest(null)).toBe(false);
    expect(isPageRequest(undefined)).toBe(false);
    expect(isPageRequest('lumo:page:read')).toBe(false);
  });

  it('handles every request type rather than falling through', async () => {
    document.body.innerHTML = '<h1>Title</h1><p>Some prose to read.</p><button>Act</button>';
    for (const request of ALL_REQUESTS) {
      const response = await handlePageRequest(request);
      // `resolve-ref` / `act` legitimately fail on a stale ref; what must never
      // happen is the "Unknown page request" fallthrough.
      expect(response.ok === false ? response.error : '').not.toMatch(/Unknown page request/);
    }
  });

  it('reports an unknown request type instead of throwing', async () => {
    const response = await handlePageRequest({ type: 'lumo:page:nope' } as unknown as PageRequest);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error).toMatch(/Unknown page request/);
  });
});

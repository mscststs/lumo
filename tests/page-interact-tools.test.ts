/**
 * Backward compatibility for the tools that were kept.
 *
 * Everything added in this change is additive: new optional parameters and new
 * tools. The existing selector-based path has to keep behaving exactly as before,
 * because saved conversations and user habits both depend on it.
 *
 * These tests drive the real `getAITools()` through a stubbed `chrome`, so they
 * cover the actual argument marshalling rather than a reimplementation of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageInteractMcpServer } from '@/lib/mcp/page-interact-server';

interface InjectedCall {
  args: unknown[];
  frameIds?: number[];
}

/** Calls captured from the stubbed `chrome.scripting.executeScript`. */
let injected: InjectedCall[] = [];
/** Value the stubbed injected function returns. */
let scriptResult: unknown = {};
/** Requests captured from the stubbed `chrome.tabs.sendMessage`. */
let sent: unknown[] = [];
let sendResponse: unknown = { ok: true };
let sendShouldThrow = false;

const ACTIVE_TAB_ID = 7;

beforeEach(() => {
  injected = [];
  sent = [];
  scriptResult = {};
  sendResponse = { ok: true };
  sendShouldThrow = false;

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: ACTIVE_TAB_ID }]),
      sendMessage: vi.fn(async (_tabId: number, request: unknown) => {
        if (sendShouldThrow) throw new Error('Could not establish connection.');
        sent.push(request);
        return sendResponse;
      }),
    },
    scripting: {
      executeScript: vi.fn(async (options: { args?: unknown[]; target?: { frameIds?: number[] }; files?: string[] }) => {
        injected.push({ args: options.args ?? [], frameIds: options.target?.frameIds });
        // Injecting the content script file returns no useful result.
        if (options.files) return [{ result: undefined }];
        return [{ result: scriptResult }];
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function toolFn(name: string) {
  const tool = new PageInteractMcpServer().getAITools()[name] as {
    execute: (args: unknown, context?: unknown) => Promise<unknown>;
  };
  if (!tool) throw new Error(`No such tool: ${name}`);
  return (args: Record<string, unknown>) => tool.execute(args, {});
}

describe('backward compatibility: page_get_text', () => {
  it('behaves as before for content under the limit', async () => {
    scriptResult = { text: 'Hello world' };
    const result = await toolFn('page_get_text')({});
    expect(result).toMatchObject({ text: 'Hello world', length: 11 });
  });

  it('defaults to the whole body when no selector is given', async () => {
    scriptResult = { text: 'body text' };
    await toolFn('page_get_text')({});
    expect(injected[0]!.args).toEqual(['']);
  });

  it('still forwards frameId to the injected script', async () => {
    scriptResult = { text: 'frame text' };
    await toolFn('page_get_text')({ frameId: 3 });
    // `frameId` was missing from the old hand-written schema; it must survive
    // the switch to a derived one.
    expect(injected[0]!.frameIds).toEqual([3]);
  });

  it('reports truncation instead of silently cutting', async () => {
    scriptResult = { text: 'x'.repeat(5_000) };
    const result = await toolFn('page_get_text')({ maxChars: 100 }) as {
      text: string;
      limit: { totalChars: number; truncated: boolean };
    };
    expect(result.text).toHaveLength(100);
    expect(result.limit).toMatchObject({ totalChars: 5_000, truncated: true });
  });

  it('propagates a not-found error unchanged', async () => {
    scriptResult = { error: 'Element not found: #missing' };
    expect(await toolFn('page_get_text')({ selector: '#missing' }))
      .toEqual({ error: 'Element not found: #missing' });
  });
});

describe('backward compatibility: page_get_html', () => {
  it('returns html and defaults to innerHTML', async () => {
    scriptResult = { html: '<p>hi</p>' };
    const result = await toolFn('page_get_html')({}) as { html: string };
    expect(result.html).toBe('<p>hi</p>');
    expect(injected[0]!.args).toEqual(['', false]);
  });

  it('passes outer through', async () => {
    scriptResult = { html: '<div><p>hi</p></div>' };
    await toolFn('page_get_html')({ outer: true });
    expect(injected[0]!.args).toEqual(['', true]);
  });
});

describe('backward compatibility: action tools accept a bare selector', () => {
  it('page_click still accepts a bare selector', async () => {
    scriptResult = { success: true, tag: 'button', text: 'Go' };
    const result = await toolFn('page_click')({ selector: '#go' });
    // The ref parameter is an addition, not a replacement.
    expect(result).toMatchObject({ success: true, tag: 'button' });
    expect(injected[0]!.args).toEqual(['#go']);
    expect(sent).toHaveLength(0);
  });

  it('page_fill still accepts selector plus value', async () => {
    scriptResult = { success: true, selector: '#email', filledValue: 'a@b.com' };
    await toolFn('page_fill')({ selector: '#email', value: 'a@b.com' });
    expect(injected[0]!.args).toEqual(['#email', 'a@b.com']);
  });

  it('page_check_checkbox still passes null to mean toggle', async () => {
    scriptResult = { success: true, checked: true };
    await toolFn('page_check_checkbox')({ selector: '#c' });
    expect(injected[0]!.args).toEqual(['#c', null]);
  });

  it('page_select_option still accepts selector plus value', async () => {
    scriptResult = { success: true, selectedValue: 'b' };
    await toolFn('page_select_option')({ selector: '#s', value: 'b' });
    expect(injected[0]!.args).toEqual(['#s', 'b']);
  });

  it('rejects a call with neither ref nor selector', async () => {
    // Both parameters are optional in the schema, so this has to be enforced at
    // run time rather than silently acting on the document.
    expect(await toolFn('page_click')({})).toEqual({ error: 'Provide either ref or selector' });
    expect(await toolFn('page_hover')({})).toEqual({ error: 'Provide either ref or selector' });
    expect(await toolFn('page_focus')({})).toEqual({ error: 'Provide either ref or selector' });
  });
});

describe('ref routing', () => {
  it('sends a ref action to the content script instead of injecting', async () => {
    sendResponse = { ok: true, action: 'click', ref: 'e12', element: { ref: 'e12', tag: 'button' } };
    const result = await toolFn('page_click')({ ref: 'e12' });
    expect(sent).toEqual([{ type: 'lumo:page:act', action: 'click', ref: 'e12' }]);
    expect(result).toMatchObject({ action: 'click', ref: 'e12' });
    // The `ok` discriminator is protocol plumbing, not something the model needs.
    expect(result).not.toHaveProperty('ok');
  });

  it('prefers ref over selector when both are supplied', async () => {
    sendResponse = { ok: true, action: 'click', ref: 'e1', element: { ref: 'e1', tag: 'button' } };
    await toolFn('page_click')({ ref: 'e1', selector: '#stale' });
    expect(sent).toHaveLength(1);
    expect(injected).toHaveLength(0);
  });

  it('surfaces a stale ref as an error rather than falling back to the selector', async () => {
    sendResponse = { ok: false, error: 'Element ref "e9" is no longer on the page.' };
    const result = await toolFn('page_click')({ ref: 'e9', selector: '#neighbour' });
    // Falling back here is precisely the silent-wrong-element failure mode.
    expect(result).toEqual({ error: 'Element ref "e9" is no longer on the page.' });
    expect(injected).toHaveLength(0);
  });

  it('passes fill value and checkbox state through to the content script', async () => {
    sendResponse = { ok: true, action: 'fill', ref: 'e2', element: { ref: 'e2', tag: 'input' } };
    await toolFn('page_fill')({ ref: 'e2', value: 'text' });
    expect(sent[0]).toMatchObject({ action: 'fill', ref: 'e2', value: 'text' });

    sent = [];
    sendResponse = { ok: true, action: 'check-checkbox', ref: 'e3', element: { ref: 'e3', tag: 'input' } };
    await toolFn('page_check_checkbox')({ ref: 'e3' });
    expect(sent[0]).toMatchObject({ checked: null });
    sent = [];
    await toolFn('page_check_checkbox')({ ref: 'e3', checked: true });
    expect(sent[0]).toMatchObject({ checked: true });
  });
});

describe('content script availability', () => {
  it('injects the content script and retries when no receiver exists', async () => {
    let firstCall = true;
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_tabId, request) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('Could not establish connection.');
      }
      sent.push(request);
      return { ok: true, url: 'https://example.com', title: 'T', resolvedMode: 'full', markdown: '# hi', limit: {} };
    });

    const result = await toolFn('page_read')({}) as Record<string, unknown>;
    // A tab that predates the extension has no listener until we inject one.
    expect(injected[0]!.args).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ markdown: '# hi' });
  });

  it('explains the escape hatch when injection is impossible', async () => {
    sendShouldThrow = true;
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Cannot access a chrome:// URL'),
    );

    const result = await toolFn('page_read')({}) as { error: string };
    expect(result.error).toContain('Cannot access a chrome:// URL');
    // The model has to be told what to do instead, or it will just retry.
    expect(result.error).toContain('page_get_text');
  });
});

describe('new tool request marshalling', () => {
  it('defaults page_read to auto mode with images and links', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', resolvedMode: 'article', markdown: 'm', limit: {} };
    await toolFn('page_read')({});
    expect(sent[0]).toEqual({
      type: 'lumo:page:read',
      mode: 'auto',
      selector: undefined,
      includeImages: true,
      includeLinks: true,
      maxChars: undefined,
      offset: undefined,
    });
  });

  it('defaults page_snapshot to the full tree', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', snapshot: '- main', refCount: 0, limit: {} };
    await toolFn('page_snapshot')({});
    expect(sent[0]).toMatchObject({ type: 'lumo:page:snapshot', interactiveOnly: false, depth: undefined });
  });

  it('defaults page_find context to 2', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', matches: [], totalMatches: 0, limit: {} };
    await toolFn('page_find')({ text: 'q' });
    expect(sent[0]).toMatchObject({ type: 'lumo:page:find', text: 'q', context: 2 });
  });
});

/**
 * Integration tests for the consolidated page interaction tools.
 *
 * These tests drive the real `getAITools()` through a stubbed `chrome`, covering
 * argument marshalling for the new unified tool signatures.
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

const ACTIVE_TAB_ID = 7;

beforeEach(() => {
  injected = [];
  sent = [];
  scriptResult = {};
  sendResponse = { ok: true };

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: ACTIVE_TAB_ID }]),
      sendMessage: vi.fn(async (_tabId: number, request: unknown) => {
        sent.push(request);
        return sendResponse;
      }),
    },
    scripting: {
      executeScript: vi.fn(async (options: { args?: unknown[]; target?: { frameIds?: number[] }; files?: string[] }) => {
        injected.push({ args: options.args ?? [], frameIds: options.target?.frameIds });
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

describe('page_click', () => {
  it('accepts a bare selector', async () => {
    scriptResult = { success: true, tag: 'button', text: 'Go' };
    const result = await toolFn('page_click')({ selector: '#go' });
    expect(result).toMatchObject({ success: true, tag: 'button' });
    expect(injected[0]!.args).toEqual(['#go']);
    expect(sent).toHaveLength(0);
  });

  it('routes ref to the content script', async () => {
    sendResponse = { ok: true, action: 'click', ref: 'e12', element: { ref: 'e12', tag: 'button' } };
    const result = await toolFn('page_click')({ ref: 'e12' });
    expect(sent).toEqual([{ type: 'lumo:page:act', action: 'click', ref: 'e12' }]);
    expect(result).toMatchObject({ action: 'click', ref: 'e12' });
    expect(result).not.toHaveProperty('ok');
  });

  it('prefers ref over selector when both are supplied', async () => {
    sendResponse = { ok: true, action: 'click', ref: 'e1', element: { ref: 'e1', tag: 'button' } };
    await toolFn('page_click')({ ref: 'e1', selector: '#stale' });
    expect(sent).toHaveLength(1);
    expect(injected).toHaveLength(0);
  });

  it('surfaces a stale ref as an error', async () => {
    sendResponse = { ok: false, error: 'Element ref "e9" is no longer on the page.' };
    const result = await toolFn('page_click')({ ref: 'e9', selector: '#neighbour' });
    expect(result).toEqual({ error: 'Element ref "e9" is no longer on the page.' });
    expect(injected).toHaveLength(0);
  });

  it('rejects a call with neither ref nor selector', async () => {
    expect(await toolFn('page_click')({})).toEqual({ error: 'Provide either ref or selector' });
  });
});

describe('page_fill', () => {
  it('fills text input via selector', async () => {
    scriptResult = { success: true, selector: '#email', filledValue: 'a@b.com' };
    await toolFn('page_fill')({ type: 'text', selector: '#email', value: 'a@b.com' });
    expect(injected[0]!.args).toEqual(['#email', 'a@b.com']);
  });

  it('fills text input via ref', async () => {
    sendResponse = { ok: true, action: 'fill', ref: 'e2', element: { ref: 'e2', tag: 'input' } };
    await toolFn('page_fill')({ type: 'text', ref: 'e2', value: 'text' });
    expect(sent[0]).toMatchObject({ action: 'fill', ref: 'e2', value: 'text' });
  });

  it('selects option via selector', async () => {
    scriptResult = { success: true, selectedValue: 'b' };
    await toolFn('page_fill')({ type: 'select', selector: '#s', value: 'b' });
    expect(injected[0]!.args).toEqual(['#s', 'b']);
  });

  it('selects option via ref', async () => {
    sendResponse = { ok: true, action: 'select-option', ref: 'e5', element: { ref: 'e5', tag: 'select' } };
    await toolFn('page_fill')({ type: 'select', ref: 'e5', value: 'opt1' });
    expect(sent[0]).toMatchObject({ action: 'select-option', ref: 'e5', value: 'opt1' });
  });

  it('toggles checkbox via ref (null means toggle)', async () => {
    sendResponse = { ok: true, action: 'check-checkbox', ref: 'e3', element: { ref: 'e3', tag: 'input' } };
    await toolFn('page_fill')({ type: 'check', ref: 'e3' });
    expect(sent[0]).toMatchObject({ checked: null });
  });

  it('sets checkbox explicitly via ref', async () => {
    sendResponse = { ok: true, action: 'check-checkbox', ref: 'e3', element: { ref: 'e3', tag: 'input' } };
    await toolFn('page_fill')({ type: 'check', ref: 'e3', checked: true });
    expect(sent[0]).toMatchObject({ checked: true });
  });

  it('toggles checkbox via selector (null means toggle)', async () => {
    scriptResult = { success: true, checked: true };
    await toolFn('page_fill')({ type: 'check', selector: '#c' });
    expect(injected[0]!.args).toEqual(['#c', null]);
  });

  it('batch fills multiple fields', async () => {
    scriptResult = { results: [{ selector: '#a', success: true }] };
    await toolFn('page_fill')({
      type: 'batch',
      fields: [{ selector: '#a', value: 'hello' }],
    });
    expect(injected[0]!.args).toEqual([[{ selector: '#a', value: 'hello' }]]);
  });

  it('rejects text fill with neither ref nor selector', async () => {
    expect(await toolFn('page_fill')({ type: 'text', value: 'x' })).toEqual({ error: 'Provide either ref or selector' });
  });
});

describe('page_keyboard', () => {
  it('types text into focused element', async () => {
    scriptResult = { success: true, typed: 'hi', length: 2 };
    const result = await toolFn('page_keyboard')({ action: 'type', text: 'hi' });
    expect(result).toMatchObject({ success: true, typed: 'hi' });
    expect(injected[0]!.args).toEqual(['hi', '']);
  });

  it('presses a key', async () => {
    scriptResult = { success: true, key: 'Enter' };
    const result = await toolFn('page_keyboard')({ action: 'press', key: 'Enter' });
    expect(result).toMatchObject({ success: true, key: 'Enter' });
    expect(injected[0]!.args).toEqual(['Enter', '']);
  });
});

describe('page_wait', () => {
  it('returns success when condition is met', async () => {
    scriptResult = { ok: true, value: true };
    const result = await toolFn('page_wait')({ condition: 'document.title === "Ready"' });
    expect(result).toMatchObject({ success: true, condition: 'document.title === "Ready"' });
  });

  it('returns error on timeout', async () => {
    scriptResult = { ok: true, value: false };
    const result = await toolFn('page_wait')({ condition: 'false', timeout: 200 }) as { error: string };
    expect(result.error).toContain('Timeout');
  });
});

describe('page_snapshot with filter (absorbs page_find)', () => {
  it('routes filter text to the find pathway', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', matches: [], totalMatches: 0, limit: {} };
    await toolFn('page_snapshot')({ filter: 'search text' });
    expect(sent[0]).toMatchObject({ type: 'lumo:page:find', text: 'search text', context: 2 });
  });

  it('routes regex filter to the find pathway', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', matches: [], totalMatches: 0, limit: {} };
    await toolFn('page_snapshot')({ filter: '/error/i' });
    expect(sent[0]).toMatchObject({ type: 'lumo:page:find', regex: '/error/i', context: 2 });
  });

  it('uses full snapshot when no filter is given', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', snapshot: '- main', refCount: 0, limit: {} };
    await toolFn('page_snapshot')({});
    expect(sent[0]).toMatchObject({ type: 'lumo:page:snapshot', interactiveOnly: false });
  });
});

describe('content script availability', () => {
  it('injects and retries when a foreign listener answers with undefined', async () => {
    let injectedYet = false;
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_tabId, request) => {
      if (!injectedYet) return undefined;
      sent.push(request);
      return { ok: true, url: 'https://example.com', title: 'T', resolvedMode: 'full', markdown: '# hi', limit: {} };
    });
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      injectedYet = true;
      return [{ result: undefined }];
    });

    const result = await toolFn('page_read')({}) as Record<string, unknown>;
    expect(result).toMatchObject({ markdown: '# hi' });
    expect(sent).toHaveLength(1);
  });

  it('injects and retries when no listener exists at all', async () => {
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
    expect(injected[0]!.args).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ markdown: '# hi' });
  });

  it('does not inject when the script already answered', async () => {
    sendResponse = { ok: true, url: 'u', title: 't', resolvedMode: 'full', markdown: 'm', limit: {} };
    await toolFn('page_read')({});
    expect(injected).toHaveLength(0);
  });

  it('reports a page that stays silent after injection', async () => {
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await toolFn('page_read')({}) as { error: string };
    expect(result.error).toContain('did not respond after injection');
  });

  it('explains the restriction when injection is impossible', async () => {
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Cannot access a chrome:// URL'),
    );

    const result = await toolFn('page_read')({}) as { error: string };
    expect(result.error).toContain('Cannot access a chrome:// URL');
    expect(result.error).toContain('page_evaluate');
  });
});

describe('page_read request marshalling', () => {
  it('defaults to auto mode with images and links', async () => {
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
});

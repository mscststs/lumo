/**
 * @vitest-environment jsdom
 *
 * Orphaned-context behaviour of the WebMCP bridge.
 *
 * A content script outlives the extension that injected it. Reloading,
 * updating or disabling the extension leaves the bridge attached to a live page
 * with a dead `chrome.runtime`, and `disableWebMcp` only unregisters *future*
 * injections — so every already-open tab keeps an orphaned bridge.
 *
 * The original bug: `chrome.runtime.sendMessage` throws *synchronously* once the
 * context is invalidated. It does not return a rejected promise, so the
 * `.catch()` the bridge relied on never ran and the error escaped the `message`
 * listener as an uncaught "Extension context invalidated." On an SPA that
 * re-registers tools on every route change, that is one uncaught error per
 * navigation, forever.
 *
 * These tests deliberately invoke the entrypoint the way WXT's generated wrapper
 * does — `main()` with **no arguments**. WXT types an entrypoint by file name,
 * and `content-webmcp-bridge.ts` is not `content.ts`/`*.content.ts`, so it is
 * built as an unlisted script and gets no `ContentScriptContext`. An earlier fix
 * here took a `ctx` parameter and crashed on every page with "Cannot read
 * properties of undefined (reading 'onInvalidated')"; the test suite missed it
 * precisely because it hand-fed a `ctx` the real runtime never supplies. Passing
 * nothing is therefore load-bearing, not incidental.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What WXT's wrapper actually calls: a zero-argument main. */
type BridgeMain = () => void;

/**
 * A `chrome` stub whose `sendMessage` reproduces Chrome's real orphan
 * behaviour: a synchronous throw, not a rejected promise.
 */
function makeChrome() {
  const listeners: Array<
    (m: unknown, s: unknown, r: (v?: unknown) => void) => boolean | undefined
  > = [];
  const sent: unknown[] = [];
  let orphaned = false;

  const runtime = {
    /** Reads `undefined` on an orphaned script — the signal the bridge uses. */
    get id(): string | undefined {
      return orphaned ? undefined : 'test-extension-id';
    },
    sendMessage: vi.fn((message: unknown) => {
      if (orphaned) throw new Error('Extension context invalidated.');
      sent.push(message);
      return Promise.resolve();
    }),
    onMessage: {
      addListener: (fn: (typeof listeners)[number]) => {
        listeners.push(fn);
      },
      removeListener: (fn: (typeof listeners)[number]) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  };

  return {
    sent,
    listeners,
    /** Simulate an extension reload/update/disable. */
    orphan() {
      orphaned = true;
    },
    api: { runtime },
  };
}

/**
 * Load the entrypoint, stubbing `defineUnlistedScript` the way WXT's generated
 * wrapper resolves it: identity, returning the bare main function.
 */
async function loadBridge(): Promise<BridgeMain> {
  vi.resetModules();
  (globalThis as any).defineUnlistedScript = (main: BridgeMain) => main;
  const mod = await import('@/entrypoints/content-webmcp-bridge');
  return mod.default as unknown as BridgeMain;
}

/**
 * Dispatch a page message the way the MAIN world does, capturing anything the
 * listener throws. jsdom reports a throwing listener via `window.onerror`
 * rather than propagating out of `dispatchEvent`, which is exactly how the real
 * "Uncaught Error" surfaced.
 */
function postFromPage(data: unknown): Error[] {
  const errors: Error[] = [];
  const onError = (event: ErrorEvent) => {
    errors.push(event.error ?? new Error(event.message));
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  window.dispatchEvent(
    new MessageEvent('message', { data, source: window as any }),
  );
  window.removeEventListener('error', onError);
  return errors;
}

const TOOLS_REPORT = {
  type: 'webmcp:tools-report',
  tools: [],
  pageTitle: 'Services',
  pageUrl: 'https://example.test/admin/services',
};

let chromeStub: ReturnType<typeof makeChrome>;

function backgroundListener(): (
  m: unknown,
  s: unknown,
  r: (v?: unknown) => void,
) => boolean | undefined {
  const listener = chromeStub.listeners[0];
  if (!listener) throw new Error('bridge registered no runtime.onMessage listener');
  return listener;
}

/**
 * Start a bridge in the shared jsdom window, exactly as WXT would.
 *
 * jsdom keeps one `window` per file, so a bridge left attached by an earlier
 * test still hears `postMessage` and relays into the *next* test's `chrome`
 * stub. Every bridge is torn down in `afterEach` via the production shutdown
 * path.
 */
async function startBridge(): Promise<void> {
  const main = await loadBridge();
  main();
}

beforeEach(() => {
  chromeStub = makeChrome();
  (globalThis as any).chrome = chromeStub.api;
  delete (window as any).__lumoWebmcpBridgeReady;
});

afterEach(() => {
  // Use the real shutdown message so leftover bridges detach themselves.
  for (const listener of [...chromeStub.listeners]) {
    listener({ type: 'webmcp:shutdown' }, {}, () => {});
  }
  delete (globalThis as any).chrome;
  delete (globalThis as any).defineUnlistedScript;
  delete (window as any).__lumoWebmcpBridgeReady;
});

describe('webmcp bridge entrypoint shape', () => {
  it('starts without any argument, as WXT invokes it', async () => {
    // WXT builds this file as an unlisted script and calls `main()` with no
    // arguments. Depending on a `ctx` parameter crashes on every page.
    const main = await loadBridge();
    expect(main).toHaveLength(0);
    expect(() => main()).not.toThrow();
  });

  it('exports a bare function, not a content-script definition object', async () => {
    // A `{ matches, runAt, registration }` object here would be dead config:
    // WXT ignores it for unlisted scripts, and `webmcp-manager.ts` does the
    // real registration.
    const main = await loadBridge();
    expect(typeof main).toBe('function');
  });
});

describe('webmcp bridge relay', () => {
  it('relays a well-formed tool report to the background', async () => {
    await startBridge();

    const errors = postFromPage(TOOLS_REPORT);

    expect(errors).toEqual([]);
    expect(chromeStub.sent).toEqual([TOOLS_REPORT]);
  });

  it('does not throw when the context is invalidated mid-session', async () => {
    await startBridge();

    // The extension is reloaded. The page keeps running and keeps reporting.
    chromeStub.orphan();

    const errors = postFromPage(TOOLS_REPORT);

    // The regression: a synchronous throw from sendMessage escaping the
    // listener as "Uncaught Error: Extension context invalidated."
    expect(errors).toEqual([]);
  });

  it('stops attempting to send once orphaned', async () => {
    await startBridge();
    chromeStub.orphan();

    postFromPage(TOOLS_REPORT);

    // Not merely swallowed — never attempted.
    expect(chromeStub.api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('detaches itself on the first orphaned relay attempt', async () => {
    await startBridge();
    chromeStub.orphan();

    postFromPage(TOOLS_REPORT);

    // Flag released so a freshly injected bridge can take over the document.
    expect((window as any).__lumoWebmcpBridgeReady).toBe(false);
    expect(chromeStub.listeners).toHaveLength(0);
  });

  it('tells the MAIN world to stand down once orphaned', async () => {
    await startBridge();

    const posted: unknown[] = [];
    const spy = (event: MessageEvent) => posted.push(event.data);
    window.addEventListener('message', spy);

    chromeStub.orphan();
    postFromPage(TOOLS_REPORT);
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener('message', spy);

    // Without this the page keeps posting into a dead bridge on every SPA
    // route change, which is what made one reload produce endless errors.
    expect(posted).toContainEqual({
      type: 'webmcp:bridge-gone',
      source: 'lumo-extension',
    });
  });

  it('survives being injected into an already-dead context', async () => {
    const main = await loadBridge();
    chromeStub.orphan();

    expect(() => main()).not.toThrow();
  });
});

describe('webmcp bridge message validation', () => {
  it('ignores page messages that are not part of the protocol', async () => {
    await startBridge();

    // The MAIN world is the page's own world, so a page can post anything.
    postFromPage({ type: 'webmcp:evil', payload: 'drop tables' });
    postFromPage({ type: 42 });
    postFromPage('webmcp:tools-report');
    postFromPage(null);

    expect(chromeStub.sent).toEqual([]);
  });

  it('ignores messages that did not come from this window', async () => {
    await startBridge();

    window.dispatchEvent(
      new MessageEvent('message', { data: TOOLS_REPORT, source: null }),
    );

    expect(chromeStub.sent).toEqual([]);
  });
});

describe('webmcp bridge double injection', () => {
  it('does not install a second bridge in the same document', async () => {
    // `enableWebMcp` registers the script *and* injects it into open tabs, so
    // the file lands twice. Two bridges relay every report twice and both
    // answer the same sendResponse — Chrome closes the port after the first.
    await startBridge();
    await startBridge();

    expect(chromeStub.listeners).toHaveLength(1);

    postFromPage(TOOLS_REPORT);
    expect(chromeStub.sent).toEqual([TOOLS_REPORT]);
  });
});

describe('webmcp bridge tool execution', () => {
  it('answers exactly once when the MAIN world replies', async () => {
    await startBridge();

    const sendResponse = vi.fn();
    const handled = backgroundListener()(
      {
        type: 'webmcp:execute-tool',
        executionId: 'exec-1',
        toolName: 'doThing',
        args: '{}',
      },
      {},
      sendResponse,
    );
    expect(handled).toBe(true);

    // MAIN world answers twice (a duplicated page monitor, say).
    for (let i = 0; i < 2; i++) {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window as any,
          data: {
            type: 'webmcp:execute-result',
            executionId: 'exec-1',
            success: true,
            result: '"ok"',
          },
        }),
      );
    }

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: '"ok"',
      error: undefined,
    });
  });

  it('answers with an error when the MAIN world never replies', async () => {
    vi.useFakeTimers();
    try {
      await startBridge();

      const sendResponse = vi.fn();
      backgroundListener()(
        {
          type: 'webmcp:execute-tool',
          executionId: 'exec-2',
          toolName: 'hangs',
          args: '{}',
        },
        {},
        sendResponse,
      );

      // The page navigated, or the tool hung. Leaving the port open until the
      // background's own timeout fires loses the diagnosis.
      vi.advanceTimersByTime(30_000);

      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches when the background says the feature was switched off', async () => {
    await startBridge();

    backgroundListener()({ type: 'webmcp:shutdown' }, {}, vi.fn());

    expect((window as any).__lumoWebmcpBridgeReady).toBe(false);
    postFromPage(TOOLS_REPORT);
    expect(chromeStub.sent).toEqual([]);
  });

  it('declines foreign messages so other listeners can answer them', async () => {
    await startBridge();

    // The page content script shares this listener; claiming its traffic
    // would break every page tool.
    const result = backgroundListener()(
      { type: 'lumo:page:read' },
      {},
      vi.fn(),
    );
    expect(result).toBe(false);
  });
});

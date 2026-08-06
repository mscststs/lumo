/**
 * WebMCP MAIN world content script.
 *
 * Runs in the page's MAIN world to access document.modelContext.
 * Responsibilities:
 * 1. Initialize the WebMCP polyfill (gives every page document.modelContext)
 * 2. Monitor tool registrations via the testing shim's listTools/callbacks
 * 3. Communicate tool changes to the ISOLATED world bridge via window.postMessage
 *
 * Injection is hand-rolled in `webmcp-manager.ts` (MAIN world, document_start)
 * and only happens when the WebMCP feature is enabled in settings.
 *
 * `defineUnlistedScript`, not `defineContentScript`: WXT types an entrypoint by
 * *file name*, and only `content.ts` / `*.content.ts` become content scripts.
 * This file is built as an unlisted script whatever it declares, so the
 * `matches` / `world` / `runAt` / `registration` keys that used to sit here were
 * silently ignored — they described a registration WXT never performed, while
 * the real one lives in `webmcp-manager.ts`. Worse, the content-script form
 * promises a `ContentScriptContext` argument that an unlisted script is never
 * given.
 */
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

export default defineUnlistedScript(() => {
  // `enableWebMcp` registers the script *and* injects it into open tabs, so
  // the same file lands in one document twice on the enabling pass. A second
  // copy re-runs the polyfill and doubles every tool report.
  const guard = window as typeof window & { __lumoWebmcpMainReady?: boolean };
  if (guard.__lumoWebmcpMainReady) return;
  guard.__lumoWebmcpMainReady = true;

  /**
   * Whether the ISOLATED-world bridge is still reachable.
   *
   * The bridge outlives the extension that injected it and tells us when it
   * has been orphaned. Reporting into a dead bridge is not merely wasted
   * work: it is what produced the uncaught "Extension context invalidated."
   * on every SPA route change, because this page re-registers its tools
   * constantly and each report drove a `chrome.runtime.sendMessage`.
   */
  let bridgeAlive = true;

  // ========================================================================
  // Initialize polyfill
  // ========================================================================
  initializeWebMCPPolyfill({ installTestingShim: 'if-missing' });

  // ========================================================================
  // Tool discovery and reporting
  // ========================================================================

  function reportTools(): void {
    if (!bridgeAlive) return;
    const testingCtx = (navigator as any).modelContextTesting;
    if (testingCtx && typeof testingCtx.listTools === 'function') {
      const tools = testingCtx.listTools();
      const toolInfos = (Array.isArray(tools) ? tools : []).map(
        (t: any) => {
          // inputSchema from listTools() may be a JSON string or an object
          let schema = t.inputSchema;
          if (typeof schema === 'string') {
            try {
              schema = JSON.parse(schema);
            } catch {
              schema = { type: 'object', properties: {} };
            }
          }
          return {
            name: t.name || '',
            description: t.description || '',
            inputSchema: schema || { type: 'object', properties: {} },
          };
        },
      );

      window.postMessage(
        {
          type: 'webmcp:tools-report',
          tools: toolInfos,
          pageTitle: document.title,
          pageUrl: location.href,
        },
        '*',
      );
    } else {
      // modelContext exists (we just polyfilled it) but no tools registered yet
      window.postMessage(
        {
          type: 'webmcp:tools-report',
          tools: [],
          pageTitle: document.title,
          pageUrl: location.href,
        },
        '*',
      );
    }
  }

  async function executeTool(
    executionId: string,
    toolName: string,
    argsJson: string,
  ): Promise<void> {
    try {
      const testingCtx = (navigator as any).modelContextTesting;
      if (!testingCtx || typeof testingCtx.executeTool !== 'function') {
        window.postMessage(
          {
            type: 'webmcp:execute-result',
            executionId,
            success: false,
            error: 'modelContextTesting.executeTool not available',
          },
          '*',
        );
        return;
      }

      const result = await testingCtx.executeTool(toolName, argsJson);
      window.postMessage(
        {
          type: 'webmcp:execute-result',
          executionId,
          success: true,
          result: typeof result === 'string' ? result : JSON.stringify(result),
        },
        '*',
      );
    } catch (err) {
      window.postMessage(
        {
          type: 'webmcp:execute-result',
          executionId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        '*',
      );
    }
  }

  // ========================================================================
  // Message handling from the ISOLATED world bridge
  // ========================================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.source !== 'lumo-extension') return;

    switch (event.data.type) {
      case 'webmcp:request-tools':
        reportTools();
        break;
      case 'webmcp:execute-tool':
        executeTool(
          event.data.executionId,
          event.data.toolName,
          event.data.args,
        );
        break;
      case 'webmcp:bridge-ready':
        // Bridge connected (or reconnected after an extension reload).
        bridgeAlive = true;
        reportTools();
        break;
      case 'webmcp:bridge-gone':
        // Bridge orphaned by an extension reload/update/disable. Stop
        // reporting until a fresh bridge announces itself.
        bridgeAlive = false;
        break;
    }
  });

  // ========================================================================
  // Listen for tool changes
  // ========================================================================

  const ctx = document.modelContext ?? (navigator as any).modelContext;
  if (ctx && typeof (ctx as any).addEventListener === 'function') {
    (ctx as any).addEventListener('toolchange', () => {
      reportTools();
    });
  }

  // Also use the testing shim's callback mechanism
  const testingCtx = (navigator as any).modelContextTesting;
  if (
    testingCtx &&
    typeof testingCtx.registerToolsChangedCallback === 'function'
  ) {
    testingCtx.registerToolsChangedCallback(() => {
      reportTools();
    });
  }

  // Initial report after a brief delay to allow page tools to register
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(reportTools, 50);
    });
  } else {
    setTimeout(reportTools, 50);
  }

  // Report on unload
  window.addEventListener('beforeunload', () => {
    if (!bridgeAlive) return;
    window.postMessage({ type: 'webmcp:unload' }, '*');
  });
});

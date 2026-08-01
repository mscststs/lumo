/**
 * WebMCP MAIN world content script.
 *
 * Runs in the page's MAIN world to access document.modelContext.
 * Responsibilities:
 * 1. Initialize the WebMCP polyfill (gives every page document.modelContext)
 * 2. Monitor tool registrations via the testing shim's listTools/callbacks
 * 3. Communicate tool changes to the ISOLATED world bridge via window.postMessage
 *
 * This script is registered dynamically (registration: 'runtime') and only
 * injected when the WebMCP feature is enabled in settings.
 */
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  registration: 'runtime',

  main() {
    // ========================================================================
    // Initialize polyfill
    // ========================================================================
    initializeWebMCPPolyfill({ installTestingShim: 'if-missing' });

    // ========================================================================
    // Tool discovery and reporting
    // ========================================================================

    function reportTools(): void {
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
          // Bridge connected, do initial report
          reportTools();
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
      window.postMessage({ type: 'webmcp:unload' }, '*');
    });
  },
});

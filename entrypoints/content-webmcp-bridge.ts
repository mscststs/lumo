/**
 * WebMCP Content Script - ISOLATED world
 *
 * This content script acts as a bridge between the MAIN world (where
 * document.modelContext lives) and the extension's background service worker.
 *
 * Architecture:
 * - Background injects the polyfill + monitor into MAIN world
 * - MAIN world script communicates tool changes via window.postMessage
 * - This ISOLATED world script relays messages to/from the background
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  registration: 'runtime',

  main() {
    // Listen for messages from the MAIN world (the injected webmcp monitor)
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (!event.data.type?.startsWith('webmcp:')) return;

      // Relay to background
      chrome.runtime.sendMessage(event.data).catch(() => {
        // Extension context invalidated (e.g. extension updated)
      });
    });

    // Listen for messages from background (tool execution requests, etc.)
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;
      if (!message.type?.startsWith('webmcp:')) return false;

      if (message.type === 'webmcp:request-tools') {
        // Forward to MAIN world
        window.postMessage(
          { type: 'webmcp:request-tools', source: 'lumo-extension' },
          '*',
        );
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === 'webmcp:execute-tool') {
        // Forward execution request to MAIN world and wait for response
        const { executionId, toolName, args } = message;

        const handler = (event: MessageEvent) => {
          if (event.source !== window) return;
          if (!event.data || event.data.type !== 'webmcp:execute-result') return;
          if (event.data.executionId !== executionId) return;

          window.removeEventListener('message', handler);
          sendResponse({
            success: event.data.success,
            result: event.data.result,
            error: event.data.error,
          });
        };

        window.addEventListener('message', handler);

        // Forward to MAIN world
        window.postMessage(
          {
            type: 'webmcp:execute-tool',
            source: 'lumo-extension',
            executionId,
            toolName,
            args,
          },
          '*',
        );

        // Return true to indicate async response
        return true;
      }

      return false;
    });

    // Notify that bridge is ready
    window.postMessage(
      { type: 'webmcp:bridge-ready', source: 'lumo-extension' },
      '*',
    );
  },
});

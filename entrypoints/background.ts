import { mcpRegistry, initBuiltinMcpServers, registerMcpCollectors } from '@/lib/mcp';
import { initWebMcpManager } from '@/lib/mcp/webmcp-manager';

export default defineBackground(() => {
  // Session storage defaults to TRUSTED_CONTEXTS only, which already covers the
  // side panel and options page, but be explicit: the MCP session store is read
  // from those pages and a silent access error there is hard to diagnose.
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch((error: Error) =>
      console.error('[Lumo] Failed to set session storage access level:', error),
    );

  // Register long-lived event collectors first and synchronously: they must be
  // live before any `await` so events fired during a service worker cold start
  // are not dropped. They also belong here rather than in the side panel, whose
  // listeners would die with the panel.
  registerMcpCollectors();

  // Initialize WebMCP manager (handles content script injection and tool monitoring)
  initWebMcpManager();

  // Open side panel when browser action icon is clicked
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: Error) => console.error('Failed to set panel behavior:', error));

  // Initialize all built-in MCP servers
  initBuiltinMcpServers().then(() => {
    console.log('[Lumo] MCP servers initialized:', mcpRegistry.getAllStates());
  }).catch((error) => {
    console.error('[Lumo] Failed to initialize MCP servers:', error);
  });
});

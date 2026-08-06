import { mcpRegistry, initBuiltinMcpServers, registerMcpCollectors } from '@/lib/mcp';
import { initWebMcpManager } from '@/lib/mcp/webmcp-manager';
import { registerContextMenus } from '@/lib/context-menu';
import { dropLegacyConversationsKey } from '@/store/storage';

export default defineBackground(() => {
  // Release the abandoned chat-history key as early as possible.
  //
  // Chat history moved to IndexedDB, but the old `conversations` key must still
  // be deleted: `chrome.storage` enforces its 10 MB budget across the whole
  // `local` area, so as long as that key sits there it can starve *every* other
  // write — saving a provider or a model choice included.
  //
  // This belongs in the background, not the side panel: the options page can be
  // opened first (right-click → Options) and would otherwise hit a full quota.
  // The background runs before any extension page in every entry path.
  dropLegacyConversationsKey().catch((error: Error) =>
    console.error('[Lumo] Failed to release legacy conversation storage:', error),
  );

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

  // Register right-click context menu items (synchronous listener registration)
  registerContextMenus();

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

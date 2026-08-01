export * from './types';
export * from './registry';
export { BrowserMcpServer } from './browser-server';
export { PageInteractMcpServer } from './page-interact-server';
export { NetworkMonitorMcpServer } from './network-monitor-server';
export { DevToolsAdvancedMcpServer } from './devtools-advanced-server';
export { FileMcpServer } from './file-server';
export { ExternalMcpServer } from './external-server';
export { fileStorage } from './file-storage';
export type { FileMetadata, StoredFile } from './file-storage';
export { inferMimeType, getPreviewCategory, getLanguageFromMime } from './file-storage';
export { registerMcpCollectors } from './collectors';
export {
  networkLog,
  consoleLog,
  attachedTabs,
  type NetworkRequestRecord,
  type ConsoleMessageRecord,
} from './session-store';

import { mcpRegistry } from './registry';
import { BrowserMcpServer } from './browser-server';
import { PageInteractMcpServer } from './page-interact-server';
import { NetworkMonitorMcpServer } from './network-monitor-server';
import { DevToolsAdvancedMcpServer } from './devtools-advanced-server';
import { FileMcpServer } from './file-server';
import { ExternalMcpServer } from './external-server';
import { storage } from '@/store/storage';
import type { McpHttpServerConfig } from './types';

/**
 * Initialize all built-in MCP servers and connect them.
 * Safe to call multiple times - will skip if servers are already registered.
 *
 * Every trusted context (background, side panel, options) needs its own
 * registry: tools execute in whichever context runs the chat, so the tool
 * definitions must exist there. Only the shared *state* is centralised, via
 * `session-store`; the event listeners that produce it are registered once in
 * the background by `registerMcpCollectors`.
 */
export async function initBuiltinMcpServers(): Promise<void> {
  if (mcpRegistry.getAllServers().length > 0) return;

  mcpRegistry.register(new BrowserMcpServer());
  mcpRegistry.register(new PageInteractMcpServer());
  mcpRegistry.register(new NetworkMonitorMcpServer());
  mcpRegistry.register(new DevToolsAdvancedMcpServer());
  mcpRegistry.register(new FileMcpServer());

  // Load and register external MCP servers from storage
  await initExternalMcpServers();

  await mcpRegistry.connectAll();
}

/**
 * Load external MCP server configurations from storage and register them.
 */
async function initExternalMcpServers(): Promise<void> {
  try {
    const settings = await storage.getMcpSettings();
    for (const serverConfig of settings.servers) {
      if (serverConfig.transport === 'webmcp') continue; // WebMCP handled separately
      registerExternalServer(serverConfig);
    }
  } catch (err) {
    console.error('Failed to load external MCP servers:', err);
  }
}

/**
 * Register a single external MCP server in the registry.
 * Does not connect it - call mcpRegistry.connectAll() or server.connect() after.
 */
export function registerExternalServer(config: McpHttpServerConfig): ExternalMcpServer {
  // Unregister existing server with same ID if present
  const existing = mcpRegistry.getServer(config.id);
  if (existing) {
    mcpRegistry.unregister(config.id);
  }

  const server = new ExternalMcpServer(config, () => mcpRegistry.notifyChange());
  mcpRegistry.register(server);
  return server;
}

/**
 * Unregister an external MCP server and remove it from the registry.
 */
export function unregisterExternalServer(id: string): void {
  mcpRegistry.unregister(id);
}

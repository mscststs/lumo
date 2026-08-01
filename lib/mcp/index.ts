export * from './types';
export * from './registry';
export { BrowserMcpServer } from './browser-server';
export { PageInteractMcpServer } from './page-interact-server';
export { NetworkMonitorMcpServer } from './network-monitor-server';
export { DevToolsAdvancedMcpServer } from './devtools-advanced-server';
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

  await mcpRegistry.connectAll();
}

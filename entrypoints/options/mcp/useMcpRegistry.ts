import { useSyncExternalStore } from 'react';
import { mcpRegistry } from '@/lib/mcp';
import type { McpServerState } from '@/lib/mcp/types';

/**
 * Live registry snapshot for the options page.
 *
 * Deliberately a *projection* and nothing else: no `useState`, no fetching, no
 * effect. Registration happens before the first frame (`entrypoints/options/
 * main.tsx` awaits `initMcpRegistry()`, which is local work — one settings read
 * and a handful of constructors), and connections are started there too, without
 * being awaited. Both used to live in this hook, behind a `loading` flag that
 * stayed true for as long as the slowest remote server took to connect — which
 * is why one unreachable MCP endpoint blanked the entire page.
 *
 * `useSyncExternalStore` rather than `useState` + `subscribe`: the registry is
 * the store, its snapshot is stable by identity, and a mutation that lands
 * between subscribe and the first read can no longer be missed (the tearing case
 * the hand-rolled version silently had).
 */
export function useMcpRegistry(): McpServerState[] {
  return useSyncExternalStore(
    (listener) => mcpRegistry.subscribe(listener),
    () => mcpRegistry.getSnapshot(),
    // No server-side renderer here, but React requires the third argument when
    // it cannot detect a browser; the same snapshot is the honest answer.
    () => mcpRegistry.getSnapshot(),
  );
}

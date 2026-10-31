import { useCallback, useEffect, useState } from 'react';
import { mcpRegistry, initBuiltinMcpServers } from '@/lib/mcp';
import type { McpServerState } from '@/lib/mcp/types';

/**
 * Live registry snapshot for the options page.
 *
 * `refresh` is the only way to hydrate the list: built-in servers are
 * registered once per trusted context, so the page cannot assume another
 * surface already ran `initBuiltinMcpServers`.
 */
export function useMcpRegistry() {
  const [states, setStates] = useState<McpServerState[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (mcpRegistry.getAllServers().length === 0) {
        await initBuiltinMcpServers();
      }
      setStates(mcpRegistry.getAllStates());
    } catch (err) {
      console.error('Failed to refresh MCP states:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Every status/tool change flows through the registry, so one subscription
    // keeps the whole page live without polling.
    return mcpRegistry.subscribe(() => setStates(mcpRegistry.getAllStates()));
  }, [refresh]);

  return { states, loading, refresh };
}

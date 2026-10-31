import { useCallback, useEffect, useState } from 'react';
import {
  mcpRegistry,
  registerExternalServer,
  unregisterExternalServer,
  ExternalMcpServer,
} from '@/lib/mcp';
import type { McpHttpServerConfig } from '@/lib/mcp/types';
import { storage } from '@/store/storage';

/**
 * A blank draft for the "add external server" dialog.
 *
 * The id is minted when the dialog opens, not on save: the stored record and the
 * registered server share it, so generating it early keeps the two in step even
 * if the user saves twice.
 */
export function createServerDraft(): McpHttpServerConfig {
  return {
    id: `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    description: '',
    transport: 'http-stream',
    url: '',
    headers: undefined,
    enabled: true,
  };
}

/**
 * HTTP/SSE servers persisted in `mcpSettings.servers`.
 *
 * Persistence and the registry are updated together on every mutation so the
 * card list and the freshness of the connection never disagree: the settings
 * write is what survives a reload, the registry call is what makes the change
 * visible immediately.
 */
export function useExternalServers() {
  const [configs, setConfigs] = useState<McpHttpServerConfig[]>([]);

  const loadConfigs = useCallback(async () => {
    const settings = await storage.getMcpSettings();
    setConfigs(settings.servers.filter((s): s is McpHttpServerConfig => s.transport !== 'webmcp'));
  }, []);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  const addServer = async (config: McpHttpServerConfig) => {
    const settings = await storage.getMcpSettings();
    settings.servers.push(config);
    await storage.setMcpSettings(settings);
    setConfigs((prev) => [...prev, config]);

    // Register and start connecting (non-blocking, UI updates via onStateChange)
    const server = registerExternalServer(config);
    void server.connect();
  };

  const removeServer = async (id: string) => {
    const settings = await storage.getMcpSettings();
    settings.servers = settings.servers.filter((s) => s.id !== id);
    await storage.setMcpSettings(settings);
    setConfigs((prev) => prev.filter((c) => c.id !== id));

    unregisterExternalServer(id);
  };

  const toggleServer = async (id: string, enabled: boolean) => {
    // 1. Persist to storage
    const settings = await storage.getMcpSettings();
    const serverIdx = settings.servers.findIndex((s) => s.id === id);
    if (serverIdx >= 0) {
      settings.servers[serverIdx] = { ...settings.servers[serverIdx]!, enabled };
      await storage.setMcpSettings(settings);
    }

    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, enabled } : c)));

    // 2. Update the server config immediately so the switch reflects instantly
    const server = mcpRegistry.getServer(id);
    if (server instanceof ExternalMcpServer) {
      server.updateConfig({ ...server.getConfig(), enabled });
      mcpRegistry.notifyChange();

      // 3. Connect/disconnect asynchronously — status updates
      //    (connecting→connected/error) arrive via onStateChange.
      if (enabled) void server.connect();
      else server.disconnect();
    } else {
      mcpRegistry.notifyChange();
    }
  };

  return { configs, addServer, removeServer, toggleServer, refresh: loadConfigs };
}

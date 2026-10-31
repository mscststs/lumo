import { useCallback, useEffect, useState } from 'react';
import { storage } from '@/store/storage';
import type { McpSettings as McpSettingsRecord } from '@/lib/mcp/types';

/**
 * Whole-record access to `mcpSettings` for the parts that are not an external
 * HTTP server: the installed-extension list.
 *
 * Subscribes to `chrome.storage.onChanged` so a provider added from the side
 * panel or another options tab lands here without a refresh — the registry and
 * this list must never disagree about which extensions are configured.
 */
export function useMcpPreferences() {
  const [settings, setSettings] = useState<McpSettingsRecord | null>(null);

  useEffect(() => {
    void storage.getMcpSettings().then(setSettings);

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes.mcpSettings) return;
      const next = changes.mcpSettings.newValue as McpSettingsRecord | undefined;
      if (next) setSettings(next);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const update = useCallback(
    async (patch: Partial<McpSettingsRecord>) => {
      const current = settings ?? (await storage.getMcpSettings());
      const next = { ...current, ...patch };
      setSettings(next);
      await storage.setMcpSettings(next);
    },
    [settings],
  );

  return { settings, update };
}

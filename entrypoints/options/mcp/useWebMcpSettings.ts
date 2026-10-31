import { useCallback, useEffect, useState } from 'react';
import { WEBMCP_SESSION_KEY } from '@/lib/mcp';
import { storage } from '@/store/storage';
import type { WebMcpTabState } from '@/lib/mcp/types';

/**
 * WebMCP enablement plus the per-tab tool census.
 *
 * Tab states live in `chrome.storage.session` (written by the background
 * worker), while the switch lives in `mcpSettings`. Both are watched: closing a
 * tab must drop its server from the list even though no setting changed.
 */
export function useWebMcpSettings() {
  const [enabled, setEnabled] = useState(false);
  const [tabStates, setTabStates] = useState<WebMcpTabState[]>([]);
  const [loading, setLoading] = useState(true);

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const settings = await storage.getMcpSettings();
      setEnabled(settings.webmcpEnabled);

      const result = await chrome.storage.session.get(WEBMCP_SESSION_KEY);
      setTabStates((result[WEBMCP_SESSION_KEY] as WebMcpTabState[] | undefined) ?? []);
    } catch (err) {
      console.error('Failed to load WebMCP state:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName === 'session' && WEBMCP_SESSION_KEY in changes) {
        setTabStates((changes[WEBMCP_SESSION_KEY].newValue as WebMcpTabState[] | undefined) ?? []);
      }
      if (areaName === 'local' && 'mcpSettings' in changes) {
        const next = changes.mcpSettings.newValue as { webmcpEnabled?: boolean } | undefined;
        if (next && typeof next.webmcpEnabled === 'boolean') setEnabled(next.webmcpEnabled);
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [loadState]);

  const toggleEnabled = async (value: boolean) => {
    const settings = await storage.getMcpSettings();
    settings.webmcpEnabled = value;
    await storage.setMcpSettings(settings);
    setEnabled(value);
  };

  return { enabled, tabStates, loading, toggleEnabled };
}

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe,
  Globe2,
  Wifi,
  WifiOff,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Wrench,
  Server,
  Plus,
  Trash2,
  Power,
  PowerOff,
  Radio,
  RadioTower,
  ExternalLink,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { McpServerState, McpToolDefinition, McpHttpServerConfig, WebMcpTabState } from '@/lib/mcp/types';
import {
  mcpRegistry,
  initBuiltinMcpServers,
  registerExternalServer,
  unregisterExternalServer,
  ExternalMcpServer,
  WEBMCP_SESSION_KEY,
} from '@/lib/mcp';
import { storage } from '@/store/storage';

// ============================================================================
// Hooks
// ============================================================================

function useInitMcpServers() {
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
    refresh();
    const unsubscribe = mcpRegistry.subscribe(() => {
      setStates(mcpRegistry.getAllStates());
    });
    return unsubscribe;
  }, [refresh]);

  return { states, loading, refresh };
}

function useExternalServers() {
  const [configs, setConfigs] = useState<McpHttpServerConfig[]>([]);

  const loadConfigs = useCallback(async () => {
    const settings = await storage.getMcpSettings();
    const httpConfigs = settings.servers.filter(
      (s): s is McpHttpServerConfig => s.transport !== 'webmcp'
    );
    setConfigs(httpConfigs);
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const addServer = async (config: McpHttpServerConfig) => {
    const settings = await storage.getMcpSettings();
    settings.servers.push(config);
    await storage.setMcpSettings(settings);
    setConfigs((prev) => [...prev, config]);

    // Register and start connecting (non-blocking, UI will update via onStateChange)
    const server = registerExternalServer(config);
    server.connect(); // fire-and-forget
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
      const existing = settings.servers[serverIdx];
      settings.servers[serverIdx] = Object.assign({}, existing, { enabled });
      await storage.setMcpSettings(settings);
    }

    setConfigs((prev) =>
      prev.map((c) => (c.id === id ? { ...c, enabled } : c))
    );

    // 2. Update server config immediately so switch reflects instantly
    const server = mcpRegistry.getServer(id);
    if (server && server instanceof ExternalMcpServer) {
      server.updateConfig({ ...server.getConfig(), enabled });
      // Notify immediately so UI shows the new enabled state + "connecting"
      mcpRegistry.notifyChange();

      // 3. Connect/disconnect asynchronously — status updates (connecting→connected/error)
      //    will be pushed to UI via the onStateChange callback in ExternalMcpServer
      if (enabled) {
        server.connect(); // fire-and-forget, onStateChange handles UI updates
      } else {
        server.disconnect();
      }
    } else {
      mcpRegistry.notifyChange();
    }
  };

  return { configs, addServer, removeServer, toggleServer, refresh: loadConfigs };
}

function useWebMcpSettings() {
  const [enabled, setEnabled] = useState(false);
  const [tabStates, setTabStates] = useState<WebMcpTabState[]>([]);
  const [loading, setLoading] = useState(true);

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const settings = await storage.getMcpSettings();
      setEnabled(settings.webmcpEnabled);

      // Load tab states from session storage
      const result = await chrome.storage.session.get(WEBMCP_SESSION_KEY);
      setTabStates(
        (result[WEBMCP_SESSION_KEY] as WebMcpTabState[] | undefined) || [],
      );
    } catch (err) {
      console.error('Failed to load WebMCP state:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();

    // Listen for session storage changes (tab states updated by background)
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName === 'session' && WEBMCP_SESSION_KEY in changes) {
        const newValue = changes[WEBMCP_SESSION_KEY].newValue as
          | WebMcpTabState[]
          | undefined;
        setTabStates(newValue || []);
      }
      if (areaName === 'local' && 'mcpSettings' in changes) {
        const newSettings = changes.mcpSettings.newValue as
          | { webmcpEnabled?: boolean }
          | undefined;
        if (newSettings && typeof newSettings.webmcpEnabled === 'boolean') {
          setEnabled(newSettings.webmcpEnabled);
        }
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

// ============================================================================
// Main Component
// ============================================================================

export function McpSettings() {
  const { t } = useTranslation();
  const { states, loading, refresh } = useInitMcpServers();
  const { configs, addServer, removeServer, toggleServer } = useExternalServers();
  const webmcp = useWebMcpSettings();
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  const builtinStates = states.filter((s) => s.info.builtin && s.info.id !== 'webmcp');
  const externalStates = states.filter((s) => !s.info.builtin);

  const toggleExpanded = (id: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleReconnect = async (serverId: string) => {
    const server = mcpRegistry.getServer(serverId);
    if (server) {
      await server.disconnect();
      mcpRegistry.notifyChange();
      server.connect(); // fire-and-forget, onStateChange handles UI
    }
  };

  return (
    <div className="max-w-2xl">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground">{t('options.mcp.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('options.mcp.description')}</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Server className="h-4 w-4" />
            <span>{t('options.mcp.servers')}</span>
          </div>
          <p className="text-2xl font-semibold mt-1">{states.length}</p>
        </div>
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wrench className="h-4 w-4" />
            <span>{t('options.mcp.tools')}</span>
          </div>
          <p className="text-2xl font-semibold mt-1">
            {states.reduce((sum, s) => sum + s.tools.length, 0)}
          </p>
        </div>
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wifi className="h-4 w-4" />
            <span>{t('options.mcp.status')}</span>
          </div>
          <p className="text-2xl font-semibold mt-1">
            {states.filter((s) => s.status === 'connected').length}/{states.length}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          <span>{t('common.loading')}</span>
        </div>
      ) : (
        <>
          {/* Built-in Servers Section */}
          <section className="mb-8">
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              {t('options.mcp.builtinSection')}
            </h3>
            <div className="space-y-2">
              {builtinStates.map((serverState) => (
                <McpServerCard
                  key={serverState.info.id}
                  state={serverState}
                  expanded={expandedServers.has(serverState.info.id)}
                  onToggle={() => toggleExpanded(serverState.info.id)}
                />
              ))}
            </div>
          </section>

          {/* External Servers Section */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                {t('options.mcp.externalSection')}
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddForm(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('options.mcp.addServer')}
              </Button>
            </div>

            {/* Add Server Form */}
            <AnimatePresence>
              {showAddForm && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <AddServerForm
                    onAdd={async (config) => {
                      await addServer(config);
                      setShowAddForm(false);
                    }}
                    onCancel={() => setShowAddForm(false)}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* External Server List */}
            {externalStates.length === 0 && !showAddForm ? (
              <p className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-lg">
                {t('options.mcp.noExternalServers')}
              </p>
            ) : (
              <div className="space-y-2">
                {externalStates.map((serverState) => (
                  <ExternalServerCard
                    key={serverState.info.id}
                    state={serverState}
                    config={configs.find((c) => c.id === serverState.info.id)}
                    expanded={expandedServers.has(serverState.info.id)}
                    onToggle={() => toggleExpanded(serverState.info.id)}
                    onReconnect={() => handleReconnect(serverState.info.id)}
                    onDelete={() => removeServer(serverState.info.id)}
                    onToggleEnabled={(enabled) =>
                      toggleServer(serverState.info.id, enabled)
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* WebMCP Section */}
          <WebMcpSection
            enabled={webmcp.enabled}
            tabStates={webmcp.tabStates}
            loading={webmcp.loading}
            onToggleEnabled={webmcp.toggleEnabled}
          />
        </>
      )}
    </div>
  );
}

// ============================================================================
// WebMCP Section
// ============================================================================

function WebMcpSection({
  enabled,
  tabStates,
  loading,
  onToggleEnabled,
}: {
  enabled: boolean;
  tabStates: WebMcpTabState[];
  loading: boolean;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [expandedTabs, setExpandedTabs] = useState<Set<number>>(new Set());

  const toggleTab = (tabId: number) => {
    setExpandedTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  };

  const totalTools = tabStates.reduce((sum, ts) => sum + ts.tools.length, 0);

  return (
    <section className="mb-6">
      {/* Section Header with Toggle */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-emerald-500" />
          <h3 className="text-sm font-medium text-muted-foreground">
            {t('options.mcp.webmcpSection.title')}
          </h3>
          {enabled && totalTools > 0 && (
            <span className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded">
              {t('options.mcp.toolCount', { count: totalTools })}
            </span>
          )}
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={enabled}
            onCheckedChange={onToggleEnabled}
          />
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground mb-3">
        {t('options.mcp.webmcpSection.description')}
      </p>

      {/* Content (only visible when enabled) */}
      <AnimatePresence>
        {enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {loading ? (
              <div className="flex items-center justify-center py-4 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                <span className="text-xs">{t('common.loading')}</span>
              </div>
            ) : tabStates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-lg">
                {t('options.mcp.webmcpSection.noTabs')}
              </p>
            ) : (
              <div className="space-y-2">
                {tabStates.map((tabState) => (
                  <WebMcpTabCard
                    key={tabState.tabId}
                    tabState={tabState}
                    expanded={expandedTabs.has(tabState.tabId)}
                    onToggle={() => toggleTab(tabState.tabId)}
                  />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function WebMcpTabCard({
  tabState,
  expanded,
  onToggle,
}: {
  tabState: WebMcpTabState;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 p-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}

        <Globe2 className="h-4 w-4 shrink-0 text-emerald-500" />

        <span className="font-medium text-sm flex-1 truncate">
          {tabState.title || t('options.mcp.webmcpSection.tabLabel', { id: tabState.tabId })}
        </span>

        <span className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded shrink-0">
          {t('options.mcp.toolCount', { count: tabState.tools.length })}
        </span>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-3 pt-0 space-y-2 border-t border-border">
              {/* Tab URL */}
              <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">{tabState.url}</span>
              </div>

              {/* Tools */}
              {tabState.tools.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  {t('options.mcp.noTools')}
                </p>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                    <Wrench className="h-3 w-3" />
                    <span>{t('options.mcp.tools')}</span>
                  </div>
                  {tabState.tools.map((tool) => (
                    <ToolItem
                      key={tool.name}
                      tool={{
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
// Add Server Form
// ============================================================================

function AddServerForm({
  onAdd,
  onCancel,
}: {
  onAdd: (config: McpHttpServerConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<'http-stream' | 'sse'>('http-stream');
  const [headersText, setHeadersText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const parseHeaders = (text: string): Record<string, string> | undefined => {
    if (!text.trim()) return undefined;
    const headers: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (key) headers[key] = value;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim() || !url.trim()) {
      return;
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      setError('Invalid URL format');
      return;
    }

    setSubmitting(true);
    try {
      const config: McpHttpServerConfig = {
        id: `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim(),
        description: description.trim(),
        transport,
        url: url.trim(),
        headers: parseHeaders(headersText),
        enabled: true,
      };
      await onAdd(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-border rounded-lg p-4 mb-3 bg-card space-y-4"
    >
      {/* Name & Transport */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="server-name" className="text-xs">
            {t('options.mcp.serverName')}
          </Label>
          <Input
            id="server-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('options.mcp.serverNamePlaceholder')}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="server-transport" className="text-xs">
            {t('options.mcp.serverType')}
          </Label>
          <div className="flex gap-2">
            <button
              type="button"
              className={`flex-1 px-3 py-2 text-xs rounded-md border transition-colors ${
                transport === 'http-stream'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent'
              }`}
              onClick={() => setTransport('http-stream')}
            >
              <div className="font-medium">{t('options.mcp.httpStream')}</div>
              <div className="text-[10px] opacity-75 mt-0.5">{t('options.mcp.httpStreamDesc')}</div>
            </button>
            <button
              type="button"
              className={`flex-1 px-3 py-2 text-xs rounded-md border transition-colors ${
                transport === 'sse'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent'
              }`}
              onClick={() => setTransport('sse')}
            >
              <div className="font-medium">{t('options.mcp.sse')}</div>
              <div className="text-[10px] opacity-75 mt-0.5">{t('options.mcp.sseDesc')}</div>
            </button>
          </div>
        </div>
      </div>

      {/* URL */}
      <div className="space-y-1.5">
        <Label htmlFor="server-url" className="text-xs">
          {t('options.mcp.serverUrl')}
        </Label>
        <Input
          id="server-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('options.mcp.serverUrlPlaceholder')}
          required
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label htmlFor="server-desc" className="text-xs">
          {t('options.mcp.serverDescription')}
        </Label>
        <Input
          id="server-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('options.mcp.serverDescriptionPlaceholder')}
        />
      </div>

      {/* Headers */}
      <div className="space-y-1.5">
        <Label htmlFor="server-headers" className="text-xs">
          {t('options.mcp.headers')}
        </Label>
        <textarea
          id="server-headers"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono min-h-[60px] resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          placeholder={t('options.mcp.headersPlaceholder')}
          rows={2}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !name.trim() || !url.trim()}>
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          {t('options.mcp.addServer')}
        </Button>
      </div>
    </form>
  );
}

// ============================================================================
// Server Cards
// ============================================================================

function McpServerCard({
  state,
  expanded,
  onToggle,
}: {
  state: McpServerState;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 p-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}

        <ServerIcon transport={state.info.transport} />

        <span className="font-medium text-sm flex-1 truncate">{state.info.name}</span>

        <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">
          {t('options.mcp.builtin')}
        </span>

        <span className="text-xs text-muted-foreground shrink-0">
          {t('options.mcp.toolCount', { count: state.tools.length })}
        </span>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ServerExpandedContent state={state} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ExternalServerCard({
  state,
  config,
  expanded,
  onToggle,
  onReconnect,
  onDelete,
  onToggleEnabled,
}: {
  state: McpServerState;
  config?: McpHttpServerConfig;
  expanded: boolean;
  onToggle: () => void;
  onReconnect: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 p-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}

        <ServerIcon transport={state.info.transport} />

        <span className="font-medium text-sm flex-1 truncate">{state.info.name}</span>

        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0 uppercase">
          {state.info.transport === 'http-stream' ? 'HTTP' : 'SSE'}
        </span>

        {state.info.enabled ? (
          <StatusBadge status={state.status} />
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <PowerOff className="h-3 w-3" />
            <span className="hidden sm:inline">{t('options.mcp.disabled')}</span>
          </span>
        )}

        <span className="text-xs text-muted-foreground shrink-0">
          {t('options.mcp.toolCount', { count: state.tools.length })}
        </span>

        {/* Enable/Disable Switch */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="shrink-0"
        >
          <Switch
            checked={state.info.enabled}
            onCheckedChange={(checked) => onToggleEnabled(checked)}
          />
        </div>

        {/* Reconnect */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onReconnect();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmingDelete(true);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Delete Confirmation */}
      <AnimatePresence>
        {confirmingDelete && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 bg-destructive/5 border-t border-border">
              <span className="text-xs text-destructive">{t('options.mcp.removeConfirm')}</span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t('options.mcp.cancelDelete')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => {
                    onDelete();
                    setConfirmingDelete(false);
                  }}
                >
                  {t('options.mcp.confirmDelete')}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Expanded Content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ServerExpandedContent state={state} config={config} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
// Shared Components
// ============================================================================

function ServerExpandedContent({
  state,
  config,
}: {
  state: McpServerState;
  config?: McpHttpServerConfig;
}) {
  const { t } = useTranslation();

  return (
    <div className="p-3 pt-0 space-y-2 border-t border-border">
      {/* Server Info */}
      <div className="text-xs text-muted-foreground mt-2">
        {state.info.description}
      </div>

      {/* URL for external servers */}
      {config && (
        <div className="text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded truncate">
          {config.url}
        </div>
      )}

      {/* Error display */}
      {state.error && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="break-all">{state.error}</span>
        </div>
      )}

      {/* Tools list */}
      {state.tools.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">{t('options.mcp.noTools')}</p>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
            <Wrench className="h-3 w-3" />
            <span>{t('options.mcp.tools')}</span>
          </div>
          {state.tools.map((tool) => (
            <ToolItem key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolItem({ tool }: { tool: McpToolDefinition }) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
      <Wrench className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-mono truncate">{tool.name}</p>
        <p className="text-xs text-muted-foreground line-clamp-2">{tool.description}</p>
      </div>
    </div>
  );
}

function ServerIcon({ transport }: { transport: string }) {
  switch (transport) {
    case 'builtin':
      return <Globe className="h-4 w-4 shrink-0 text-primary" />;
    case 'http-stream':
      return <Radio className="h-4 w-4 shrink-0 text-blue-500" />;
    case 'sse':
      return <RadioTower className="h-4 w-4 shrink-0 text-orange-500" />;
    case 'webmcp':
      return <Globe2 className="h-4 w-4 shrink-0 text-emerald-500" />;
    default:
      return <Server className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();

  switch (status) {
    case 'connected':
      return (
        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 shrink-0">
          <Wifi className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.connected')}</span>
        </span>
      );
    case 'connecting':
      return (
        <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400 shrink-0">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="hidden sm:inline">{t('options.mcp.connecting')}</span>
        </span>
      );
    case 'error':
      return (
        <span className="flex items-center gap-1 text-xs text-destructive shrink-0">
          <AlertCircle className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.error')}</span>
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <WifiOff className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.disconnected')}</span>
        </span>
      );
  }
}

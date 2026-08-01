import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe,
  Wifi,
  WifiOff,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Wrench,
  Server,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { McpServerState, McpToolDefinition } from '@/lib/mcp/types';
import { mcpRegistry, initBuiltinMcpServers } from '@/lib/mcp';

/**
 * Initialize built-in MCP servers in the options page context.
 * In a real scenario, the background script manages these,
 * but for the options page we need a local instance to display state.
 */
function useInitMcpServers() {
  const [states, setStates] = useState<McpServerState[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // If no servers registered yet (options page context), register all built-in servers
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

export function McpSettings() {
  const { t } = useTranslation();
  const { states, loading, refresh } = useInitMcpServers();
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

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
      await server.connect();
    }
  };

  return (
    <div className="max-w-2xl">
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

      {/* Server List */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          <span>{t('common.loading')}</span>
        </div>
      ) : states.length === 0 ? (
        <p className="text-muted-foreground text-sm mb-4">{t('options.mcp.noServers')}</p>
      ) : (
        <div className="space-y-3 mb-4">
          {states.map((serverState) => (
            <McpServerCard
              key={serverState.info.id}
              state={serverState}
              expanded={expandedServers.has(serverState.info.id)}
              onToggle={() => toggleExpanded(serverState.info.id)}
              onReconnect={() => handleReconnect(serverState.info.id)}
            />
          ))}
        </div>
      )}

      {/* Refresh Button */}
      <Button variant="outline" onClick={refresh} className="mb-6">
        <RefreshCw className="h-4 w-4 mr-2" />
        {t('options.mcp.reconnect')}
      </Button>
    </div>
  );
}

function McpServerCard({
  state,
  expanded,
  onToggle,
  onReconnect,
}: {
  state: McpServerState;
  expanded: boolean;
  onToggle: () => void;
  onReconnect: () => void;
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

        {state.info.builtin && (
          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">
            {t('options.mcp.builtin')}
          </span>
        )}

        <StatusBadge status={state.status} />

        <span className="text-xs text-muted-foreground shrink-0">
          {t('options.mcp.toolCount', { count: state.tools.length })}
        </span>

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
            <div className="p-3 pt-0 space-y-2">
              {/* Server Info */}
              <div className="text-xs text-muted-foreground mb-2">
                {state.info.description}
              </div>

              {/* Error display */}
              {state.error && (
                <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{state.error}</span>
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
          </motion.div>
        )}
      </AnimatePresence>
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

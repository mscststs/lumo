import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  PowerOff,
  Puzzle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { McpExtensionProviderConfig, McpServerState } from '@/lib/mcp/types';
import { CardDisclosure, ServerExpandedContent, StatusBadge } from './ServerCardParts';

/**
 * A sibling extension that serves MCP over a runtime port.
 *
 * The name comes from the provider's own self-description (`state.info.name`),
 * which only exists once the probe succeeded; until then the fallback keeps the
 * row stable instead of flickering between an id and a label.
 */
export function ExtensionProviderCard({
  config,
  state,
  expanded,
  onToggle,
  onToggleEnabled,
  onRefresh,
  onRemove,
}: {
  config: McpExtensionProviderConfig;
  state?: McpServerState;
  expanded: boolean;
  onToggle: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const current: McpServerState = state ?? {
    info: {
      id: `ext:${config.id}`,
      name: config.label ?? `Extension ${config.id.slice(0, 8)}`,
      description: '',
      transport: 'extension',
      builtin: false,
      enabled: config.enabled,
    },
    status: 'disconnected',
    tools: [],
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 p-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 rtl:-scale-x-100" />
        )}

        <Puzzle className="h-4 w-4 shrink-0 text-violet-500" />

        <span className="font-medium text-sm flex-1 truncate">{current.info.name}</span>

        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0 uppercase">
          {t('options.mcp.extensions.badge')}
        </span>

        {config.enabled ? (
          <StatusBadge status={current.status} />
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <PowerOff className="h-3 w-3" />
            <span className="hidden sm:inline">{t('options.mcp.disabled')}</span>
          </span>
        )}

        <span className="text-xs text-muted-foreground shrink-0">
          {t('options.mcp.toolCount', { count: current.tools.length })}
        </span>

        <div onClick={(event) => event.stopPropagation()} className="shrink-0">
          <Switch
            checked={config.enabled}
            onCheckedChange={(checked) => onToggleEnabled(checked)}
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          aria-label={t('options.mcp.extensions.refresh')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={(event) => {
            event.stopPropagation();
            setConfirmingRemove(true);
          }}
          aria-label={t('options.mcp.extensions.remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <AnimatePresence>
        {confirmingRemove && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 bg-destructive/5 border-t border-border">
              <span className="text-xs text-destructive">
                {t('options.mcp.extensions.removeConfirm')}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setConfirmingRemove(false)}
                >
                  {t('options.mcp.cancelDelete')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => {
                    onRemove();
                    setConfirmingRemove(false);
                  }}
                >
                  {t('options.mcp.confirmDelete')}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CardDisclosure open={expanded}>
        <ServerExpandedContent state={current} />
      </CardDisclosure>
    </div>
  );
}

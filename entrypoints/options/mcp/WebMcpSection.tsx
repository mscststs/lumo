import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, Globe2, Loader2, Wrench } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import type { WebMcpTabState } from '@/lib/mcp/types';
import { ToolItem } from './ServerCardParts';

/**
 * WebMCP: one switch plus the tabs that currently expose tools.
 *
 * The list is intentionally tab-scoped — WebMCP tools are registered by a live
 * document, so there is nothing to configure here beyond the global opt-in.
 */
export function WebMcpSection({
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
  const activeTabs = tabStates.filter((ts) => ts.tools.length > 0);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
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
          <Switch checked={enabled} onCheckedChange={onToggleEnabled} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        {t('options.mcp.webmcpSection.description')}
      </p>

      {/* Nothing to show while off: the switch is the whole story. */}
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
                <Loader2 className="h-4 w-4 animate-spin me-2" />
                <span className="text-xs">{t('common.loading')}</span>
              </div>
            ) : activeTabs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-lg">
                {t('options.mcp.webmcpSection.noTabs')}
              </p>
            ) : (
              <div className="space-y-2">
                {activeTabs.map((tabState) => (
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
          <ChevronRight className="h-4 w-4 shrink-0 rtl:-scale-x-100" />
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
              <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">{tabState.url}</span>
              </div>

              {tabState.tools.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t('options.mcp.noTools')}</p>
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

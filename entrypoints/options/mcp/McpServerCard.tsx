import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { serverDisplayName } from '@/lib/mcp/server-labels';
import type { McpServerState } from '@/lib/mcp/types';
import { CardDisclosure, ServerExpandedContent, ServerIcon } from './ServerCardParts';

/**
 * A built-in server: always enabled, so the row carries state and tool count but
 * no switch.
 */
export function McpServerCard({
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
          <ChevronRight className="h-4 w-4 shrink-0 rtl:-scale-x-100" />
        )}

        <ServerIcon transport={state.info.transport} />

        <span className="font-medium text-sm flex-1 truncate">
          {serverDisplayName(t, state.info)}
        </span>

        <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">
          {t('options.mcp.builtin')}
        </span>

        <span className="text-xs text-muted-foreground shrink-0">
          {t('options.mcp.toolCount', { count: state.tools.length })}
        </span>
      </div>

      <CardDisclosure open={expanded}>
        <ServerExpandedContent state={state} />
      </CardDisclosure>
    </div>
  );
}

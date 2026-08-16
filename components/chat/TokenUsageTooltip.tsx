import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@radix-ui/react-tooltip';
import { Button } from '@/components/ui/button';
import type { TokenUsageStats } from '@/types';

interface TokenUsageTooltipProps {
  usage: TokenUsageStats;
}

/**
 * A small dashboard-style button that shows token usage stats on hover.
 * Renders as an icon button inside MessageActions, with a rich tooltip
 * displaying the full breakdown.
 */
export function TokenUsageTooltip({ usage }: TokenUsageTooltipProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
            aria-label={t('sidebar.tokenUsage')}
          >
            <Activity className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          sideOffset={6}
          className="z-50 rounded-lg border border-border bg-popover px-3 py-2.5 shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <UsagePanel usage={usage} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function UsagePanel({ usage }: { usage: TokenUsageStats }) {
  const { t } = useTranslation();

  return (
    <div className="min-w-[180px] space-y-1.5">
      {/* Header */}
      <div className="text-[0.6875rem] font-medium text-foreground">
        {t('sidebar.tokenUsage')}
      </div>

      {/* Main stats */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.625rem] font-mono tabular-nums">
        <StatRow label={t('sidebar.tokenInput')} value={usage.inputTokens} />
        <StatRow label={t('sidebar.tokenOutput')} value={usage.outputTokens} />
        {(usage.cacheReadTokens ?? 0) > 0 && (
          <StatRow
            label={t('sidebar.tokenCacheRead')}
            value={usage.cacheReadTokens!}
            className="text-green-600 dark:text-green-400"
          />
        )}
        {(usage.cacheWriteTokens ?? 0) > 0 && (
          <StatRow
            label={t('sidebar.tokenCacheWrite')}
            value={usage.cacheWriteTokens!}
            className="text-amber-600 dark:text-amber-400"
          />
        )}
        {(usage.reasoningTokens ?? 0) > 0 && (
          <StatRow
            label={t('sidebar.tokenReasoning')}
            value={usage.reasoningTokens!}
            className="text-purple-600 dark:text-purple-400"
          />
        )}
      </div>

      {/* Divider + Total */}
      <div className="border-t border-border/50 pt-1 flex items-center justify-between text-[0.625rem] font-mono tabular-nums">
        <span className="text-muted-foreground">{t('sidebar.tokenTotal')}</span>
        <span className="font-medium text-foreground">{usage.totalTokens.toLocaleString()}</span>
      </div>

      {/* Per-step breakdown (only if multi-step) */}
      {usage.steps && usage.steps.length > 1 && (
        <div className="border-t border-border/50 pt-1 space-y-0.5">
          <div className="text-[0.6rem] text-muted-foreground/70 uppercase tracking-wide">
            {t('sidebar.tokenSteps')}
          </div>
          {usage.steps.map((step) => (
            <div
              key={step.step}
              className="flex items-center gap-2 text-[0.6rem] font-mono tabular-nums text-muted-foreground"
            >
              <span className="w-8 shrink-0 text-muted-foreground/60">
                #{step.step + 1}
              </span>
              <span>↑{step.inputTokens.toLocaleString()}</span>
              <span>↓{step.outputTokens.toLocaleString()}</span>
              {(step.cacheReadTokens ?? 0) > 0 && (
                <span className="text-green-600 dark:text-green-400">
                  ⚡{step.cacheReadTokens!.toLocaleString()}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatRow({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={className ?? 'text-foreground/80'}>
        {value.toLocaleString()}
      </span>
    </>
  );
}

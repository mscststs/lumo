import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@radix-ui/react-tooltip';
import { formatContextTokens } from '@/lib/context-window';
import type { ContextUsage } from '@/lib/context-usage';
import { cn } from '@/lib/utils';

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ContextUsageRingProps {
  usage: ContextUsage;
  /**
   * Tokens the current unsent draft would add. Rendered in the tooltip as a
   * "pending" projection only — deliberately excluded from the arc so a number
   * that changes on every keystroke cannot make the ring jitter.
   */
  pendingTokens?: number;
}

/**
 * A glanceable context-window gauge for the composer footer.
 *
 * The arc and its tone are the whole message at rest; the breakdown lives in a
 * hover tooltip, so the composer keeps its information density without a single
 * line of explanatory text. Color is the only escalation: muted under 70%,
 * warning past 70%, destructive past 90%.
 */
export function ContextUsageRing({ usage, pendingTokens = 0 }: ContextUsageRingProps) {
  const { t } = useTranslation();
  const ratio = Math.min(1, Math.max(0, usage.percent / 100));
  const offset = CIRCUMFERENCE * (1 - ratio);
  const percentLabel = `${Math.round(usage.percent)}%`;

  const tone =
    usage.percent > 90
      ? 'text-destructive'
      : usage.percent > 70
        ? 'text-amber-500'
        : 'text-muted-foreground';

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-accent',
              tone,
            )}
            aria-label={t('sidebar.contextUsageLabel', { percent: percentLabel })}
          >
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="-rotate-90"
              aria-hidden="true"
            >
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                className="stroke-muted-foreground/20"
              />
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={offset}
                className="stroke-current transition-[stroke-dashoffset] duration-200 ease-out"
              />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          sideOffset={6}
          className="z-50 rounded-lg border border-border bg-popover px-3 py-2.5 shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <ContextUsagePanel usage={usage} pendingTokens={pendingTokens} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ContextUsagePanel({
  usage,
  pendingTokens,
}: {
  usage: ContextUsage;
  pendingTokens: number;
}) {
  const { t } = useTranslation();
  const projected = usage.contextWindow > 0
    ? Math.min(100, ((usage.tokens + pendingTokens) / usage.contextWindow) * 100)
    : usage.percent;
  const remaining = Math.max(0, usage.contextWindow - usage.tokens);

  return (
    <div className="min-w-[190px] space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.6875rem] font-medium text-foreground">
          {t('sidebar.contextUsage')}
        </span>
        <span className="text-[0.6875rem] font-mono tabular-nums text-foreground">
          {`${usage.percent.toFixed(1)}%`}
        </span>
      </div>

      {/* Committed context against the declared window. */}
      <div className="text-[0.625rem] font-mono tabular-nums text-muted-foreground">
        {`${formatContextTokens(usage.tokens)} / ${formatContextTokens(usage.contextWindow)}`}
        {usage.estimated && (
          <span className="ml-1.5 text-muted-foreground/70">
            {t('sidebar.contextEstimated')}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.625rem] font-mono tabular-nums border-t border-border/50 pt-1">
        <StatRow label={t('sidebar.tokenInput')} value={usage.inputTokens} />
        <StatRow label={t('sidebar.tokenOutput')} value={usage.outputTokens} />
        {usage.cacheReadTokens > 0 && (
          <StatRow
            label={t('sidebar.tokenCacheRead')}
            value={usage.cacheReadTokens}
            className="text-green-600 dark:text-green-400"
          />
        )}
        {usage.cacheWriteTokens > 0 && (
          <StatRow
            label={t('sidebar.tokenCacheWrite')}
            value={usage.cacheWriteTokens}
            className="text-amber-600 dark:text-amber-400"
          />
        )}
      </div>

      <div className="border-t border-border/50 pt-1 flex items-center justify-between text-[0.625rem] font-mono tabular-nums">
        <span className="text-muted-foreground">{t('sidebar.contextRemaining')}</span>
        <span className="text-foreground/80">{formatContextTokens(remaining)}</span>
      </div>

      {/* Unsent draft: a projection, never part of the arc. */}
      {pendingTokens > 0 && (
        <div className="border-t border-border/50 pt-1 flex items-center justify-between text-[0.625rem] font-mono tabular-nums text-muted-foreground">
          <span>{t('sidebar.contextPending')}</span>
          <span>{`+${formatContextTokens(pendingTokens)} → ${projected.toFixed(1)}%`}</span>
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
      <span className={className ?? 'text-foreground/80'}>{value.toLocaleString()}</span>
    </>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowDown, ArrowUp, Gauge, Timer, Zap } from 'lucide-react';
import {
  METRIC_LABELS,
  formatTps,
  formatTtft,
  stepThroughput,
} from '@/lib/step-metrics';
import { Hint } from '@/components/ui/hint';
import { Button } from '@/components/ui/button';
import { messageToolbarTriggerClass } from '@/components/ai-elements/message';
import { cn } from '@/lib/utils';
import type { TokenUsageStats, TokenUsageStep } from '@/types';

interface TokenUsageTooltipProps {
  usage: TokenUsageStats;
  /** Show time to first token on each step row. From UISettings. */
  showTtft?: boolean;
  /** Show output speed on each step row. From UISettings. */
  showThroughput?: boolean;
}

/**
 * A small dashboard-style button that shows token usage stats.
 *
 * The trigger wears `messageToolbarTriggerClass` (the row's shared chrome) and
 * shares the row's 300ms delay, so this is a *rich* flavour of the same
 * disclosure, not a second system: only the content differs.
 *
 * It goes through `Hint`, which is what makes the panel reachable on a
 * touchscreen at all. Radix's tooltip ignores touch pointers and closes on the
 * click that follows a tap, so a hover-only trigger was a button that did
 * nothing on the one device where the numbers are hardest to get to. On touch
 * the same content opens as a popover by tapping the icon and stays open while
 * the ledger is scrolled.
 *
 * `provider: 'own'` is kept for the hover path. Radix's hoverable-content
 * support works with a pointer "grace area" that lets the pointer travel from
 * trigger to content without closing; while that area is active the provider
 * sets `isPointerInTransitRef`, and every trigger in that provider ignores
 * movement until the pointer leaves the hull. This panel is tall and wide, so
 * its hull covers the neighbouring buttons: sharing the row's provider made
 * hovering usage and then sliding to delete/time leave the panel open and
 * swallow the next label. A separate provider scopes the grace area to this
 * panel; when a label does open, Radix's `tooltip.open` event closes this one,
 * so only one tooltip is ever visible.
 *
 * The agent loop is uncapped by default (`lib/max-steps.ts`), so a browsing turn
 * routinely runs dozens — sometimes hundreds — of steps. Radix's popper only
 * shifts and flips its content, it never resizes it, so an unclamped step list
 * simply grows past the top of the sidepanel. The content therefore takes its
 * `max-height` from `--hint-available-height` (the real space left on the
 * chosen side, after `collisionPadding`, resolved by `Hint` for whichever
 * primitive is in use) and lets the step list — not the summary — absorb the
 * deficit as a scroll area.
 *
 * Portalled to `body` so the fixed position cannot be captured by an animating
 * ancestor (`motion.div` sets a transform) and clipped by the message scroller.
 */
export function TokenUsageTooltip({
  usage,
  showTtft = true,
  showThroughput = true,
}: TokenUsageTooltipProps) {
  const { t } = useTranslation();
  const label = t('sidebar.tokenUsage');

  return (
    <Hint
      side="top"
      align="end"
      sideOffset={6}
      contentLabel={label}
      panelClassName="flex max-h-[var(--hint-available-height)] flex-col overflow-hidden rounded-lg px-3 py-2.5 shadow-md"
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className={cn(messageToolbarTriggerClass, 'w-6')}
          aria-label={label}
        >
          <Activity className="size-3" />
        </Button>
      }
    >
      <UsagePanel usage={usage} showTtft={showTtft} showThroughput={showThroughput} />
    </Hint>
  );
}

/**
 * The hover breakdown: a fixed summary plus a scrollable per-step ledger.
 *
 * Exported so the height/scroll contract can be asserted without going through
 * Radix's hover machinery (the content only mounts while open).
 */
export function UsagePanel({
  usage,
  showTtft = true,
  showThroughput = true,
}: {
  usage: TokenUsageStats;
  showTtft?: boolean;
  showThroughput?: boolean;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const steps = usage.steps ?? [];

  // Open at the newest step: the panel is a ledger, and while a run is in flight
  // the last row is the one that keeps changing. `steps.length` re-pins the list
  // if more steps land while the panel stays open.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [steps.length]);

  return (
    // Wide enough for a full step row (tokens + TTFT + speed) on one line: the
    // panel widens instead of wrapping the timing metrics, which read as a
    // continuation of the call rather than a second entry.
    <div className="flex min-h-0 min-w-[17rem] flex-col gap-1.5 overflow-hidden">
      {/* Everything above the ledger keeps its size; the ledger gives way. */}
      <div className="shrink-0 space-y-1.5">
        <div className="text-[0.6875rem] font-medium text-foreground">
          {t('sidebar.tokenUsage')}
        </div>

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

        <div className="flex items-center justify-between border-t border-border/50 pt-1 text-[0.625rem] font-mono tabular-nums">
          <span className="text-muted-foreground">{t('sidebar.tokenTotal')}</span>
          <span className="font-medium text-foreground">
            {usage.totalTokens.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Per-step breakdown. Rendered even for a single step: this is the only
          place the step's TTFT and output speed are visible once the turn has
          settled, so hiding it for 1-step replies would hide them entirely. */}
      {steps.length > 0 && (
        <div className="flex min-h-0 flex-col border-t border-border/50 pt-1">
          <div className="flex shrink-0 items-baseline justify-between pb-0.5 text-[0.6rem] uppercase tracking-wide text-muted-foreground/70">
            <span>{t('sidebar.tokenSteps')}</span>
            <span className="font-mono tabular-nums">{steps.length}</span>
          </div>
          <div
            ref={listRef}
            data-testid="token-usage-steps"
            className="min-h-0 overflow-y-auto overscroll-contain scrollbar-lumo -me-1.5 pe-1.5"
          >
            <div className="space-y-0.5 py-0.5">
              {steps.map((step) => (
                <StepRow
                  key={step.step}
                  step={step}
                  showTtft={showTtft}
                  showThroughput={showThroughput}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One step of the ledger.
 *
 * Glyphs are Lucide icons rather than `↑ ↓ ⚡`: the text arrows inherit whatever
 * font fallback the platform picks and the lightning bolt renders as a colour
 * emoji on most systems, so the same row came out in three different weights and
 * styles. Each metric keeps its name in `title` so the icon is not the only
 * carrier of meaning.
 */
function StepRow({
  step,
  showTtft,
  showThroughput,
}: {
  step: TokenUsageStep;
  showTtft: boolean;
  showThroughput: boolean;
}) {
  const { t } = useTranslation();
  const ttft =
    showTtft && step.ttftMs != null ? formatTtft(step.ttftMs) : null;
  const throughput = showThroughput ? stepThroughput(step) : null;
  const tps = throughput != null ? formatTps(throughput) : null;

  return (
    // One row per call. `whitespace-nowrap` + `flex-nowrap` are explicit so the
    // timing pair can never drop to a second line; the panel's min width gives
    // it room instead.
    <div className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap text-[0.6rem] font-mono tabular-nums text-muted-foreground">
      <span className="min-w-[2.5ch] shrink-0 text-end text-muted-foreground/60">
        #{step.step + 1}
      </span>
      <Metric
        icon={<ArrowUp className="size-2.5" aria-hidden="true" />}
        label={t('sidebar.tokenInput')}
        value={step.inputTokens}
      />
      <Metric
        icon={<ArrowDown className="size-2.5" aria-hidden="true" />}
        label={t('sidebar.tokenOutput')}
        value={step.outputTokens}
      />
      {(step.cacheReadTokens ?? 0) > 0 && (
        <Metric
          icon={<Zap className="size-2.5" aria-hidden="true" />}
          label={t('sidebar.tokenCacheRead')}
          value={step.cacheReadTokens!}
          className="text-green-600 dark:text-green-400"
        />
      )}
      {(ttft || tps) && (
        <span
          aria-hidden="true"
          className="mx-0.5 h-2.5 w-px shrink-0 bg-border/60"
        />
      )}
      {ttft && (
        <Metric
          icon={<Timer className="size-2.5" aria-hidden="true" />}
          label={METRIC_LABELS.ttft}
          value={ttft}
        />
      )}
      {tps && (
        <Metric
          icon={<Gauge className="size-2.5" aria-hidden="true" />}
          label={METRIC_LABELS.tps}
          value={tps}
        />
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  className,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  className?: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap"
      title={label}
    >
      <span className="shrink-0 text-muted-foreground/50">{icon}</span>
      <span className={className}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </span>
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

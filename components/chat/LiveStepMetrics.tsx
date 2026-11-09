/**
 * Live generation metrics under a streaming reply: time to first token and
 * output speed.
 *
 * Rendered exactly where {@link MessageActions} renders once the turn settles,
 * so the two swap in place without moving a single pixel below them — the
 * toolbar row is 28px tall (`pt-1` + a 24px action row) and this row matches it.
 *
 * No labels: the timer and gauge icons are the whole legend, and the units
 * (`ms`/`s`, `T/s`) are the same in every language. That is why this surface
 * needs no translation, unlike a written-out "time to first token". The numbers
 * are `tabular-nums` so a changing value cannot shift its neighbours, and there
 * is deliberately no animation on update — this is a high-frequency readout,
 * not a headline.
 */
import { Gauge, Timer } from 'lucide-react';
import {
  METRIC_LABELS,
  formatTps,
  formatTtft,
  type StepMetrics,
} from '@/lib/step-metrics';

interface LiveStepMetricsProps {
  metrics: StepMetrics | null;
  /** Each metric is independently switchable from the options page. */
  showTtft?: boolean;
  showThroughput?: boolean;
}

export function LiveStepMetrics({
  metrics,
  showTtft = true,
  showThroughput = true,
}: LiveStepMetricsProps) {
  const ttft =
    showTtft && metrics?.ttftMs != null ? formatTtft(metrics.ttftMs) : null;
  const tps =
    showThroughput && metrics?.tps != null ? formatTps(metrics.tps) : null;
  if (!ttft && !tps) return null;

  return (
    <div className="flex select-none items-center gap-2 pt-1 text-[0.625rem] leading-6 text-muted-foreground/80">
      {ttft && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono tabular-nums" title={METRIC_LABELS.ttft}>
          <Timer className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span>{ttft}</span>
        </span>
      )}
      {tps && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono tabular-nums" title={METRIC_LABELS.tps}>
          <Gauge className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span>{tps}</span>
        </span>
      )}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { formatContextTokens } from '@/lib/context-window';
import type { ContextUsage } from '@/lib/context-usage';

/** Glyph shown when no provider usage has anchored the number. */
export const UNKNOWN_GLYPH = '?';
/** Placeholder for a value that is not meaningful while the size is unknown. */
const EMPTY_VALUE = '—';

interface ContextUsagePanelProps {
  usage: ContextUsage;
  /** Tokens the current unsent draft would add; rendered as a projection. */
  pendingTokens: number;
}

/**
 * The hover breakdown for the composer's context ring.
 *
 * At rest the ring carries the whole message, so this panel is free to be
 * precise: exact token counts, the anchoring step's input/output split, and the
 * remaining headroom. When the size is unknown, values are replaced by an
 * em dash rather than `0`, which would read as "nothing used" instead of
 * "not measured".
 *
 * Occupancy only. Cached input is a *subset* of the reported input tokens and
 * exists to explain a bill, not a context window, so it is deliberately absent
 * here and lives in the per-message usage tooltip instead.
 */
export function ContextUsagePanel({ usage, pendingTokens }: ContextUsagePanelProps) {
  const { t } = useTranslation();
  const unknown = usage.estimated;
  const projected =
    usage.contextWindow > 0
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
          {unknown ? UNKNOWN_GLYPH : `${usage.percent.toFixed(1)}%`}
        </span>
      </div>

      {/* Committed context against the declared window. */}
      <div className="text-[0.625rem] font-mono tabular-nums text-muted-foreground">
        {unknown
          ? `${UNKNOWN_GLYPH} / ${formatContextTokens(usage.contextWindow)}`
          : `${formatContextTokens(usage.tokens)} / ${formatContextTokens(usage.contextWindow)}`}
      </div>

      {/* Only the prompt split. Cache reads/writes are a billing breakdown of
          the same input tokens, so listing them here would double-count
          occupancy; the per-message usage tooltip owns that view. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.625rem] font-mono tabular-nums border-t border-border/50 pt-1">
        <StatRow label={t('sidebar.tokenInput')} value={unknown ? null : usage.inputTokens} />
        <StatRow label={t('sidebar.tokenOutput')} value={unknown ? null : usage.outputTokens} />
      </div>

      <div className="border-t border-border/50 pt-1 flex items-center justify-between text-[0.625rem] font-mono tabular-nums">
        <span className="text-muted-foreground">{t('sidebar.contextRemaining')}</span>
        <span className="text-foreground/80">
          {unknown ? EMPTY_VALUE : formatContextTokens(remaining)}
        </span>
      </div>

      {/* Unsent draft: a projection, never part of the arc. Hidden while the
          committed size is unknown, because the projection would inherit it. */}
      {!unknown && pendingTokens > 0 && (
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
  value: number | null;
  className?: string;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={className ?? 'text-foreground/80'}>
        {value === null ? EMPTY_VALUE : value.toLocaleString()}
      </span>
    </>
  );
}

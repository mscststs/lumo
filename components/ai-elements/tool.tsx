import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Wrench,
  Loader2,
  Check,
  AlertCircle,
  Ban,
  ShieldQuestion,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { normalizeToolOutput, safeStringify, summarizeToolInput } from '@/lib/tool-output';
import type { ToolPart } from '@/lib/message-parts';

/**
 * Compact tool-invocation display.
 *
 * Sized down from upstream ai-elements: single-line header, 11px mono body and
 * capped output height, so a tool call costs roughly one text line of vertical
 * space in a narrow sidebar.
 */

type ToolState = ToolPart['state'];

/** Terminal states are collapsed by default to keep long tool chains scannable. */
const STATUS_META: Record<
  ToolState,
  { icon: React.ElementType; className: string; i18nKey: string; spin?: boolean }
> = {
  'input-streaming': {
    icon: Loader2,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.pending',
    spin: true,
  },
  'input-available': {
    icon: Loader2,
    className: 'text-blue-600 dark:text-blue-400',
    i18nKey: 'sidebar.tool.running',
    spin: true,
  },
  'approval-requested': {
    icon: ShieldQuestion,
    className: 'text-yellow-600 dark:text-yellow-400',
    i18nKey: 'sidebar.tool.awaitingApproval',
  },
  'approval-responded': {
    icon: ShieldQuestion,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.responded',
  },
  'output-available': {
    icon: Check,
    className: 'text-green-600 dark:text-green-400',
    i18nKey: 'sidebar.tool.completed',
  },
  'output-error': {
    icon: AlertCircle,
    className: 'text-destructive',
    i18nKey: 'sidebar.tool.error',
  },
  'output-denied': {
    icon: Ban,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.denied',
  },
};

export function ToolStatusIcon({ state, className }: { state: ToolState; className?: string }) {
  const meta = STATUS_META[state] ?? STATUS_META['input-available'];
  const Icon = meta.icon;
  return (
    <Icon
      className={cn('h-3 w-3 shrink-0', meta.className, meta.spin && 'animate-spin', className)}
    />
  );
}

export function useToolStatusLabel(state: ToolState): string {
  const { t } = useTranslation();
  const meta = STATUS_META[state] ?? STATUS_META['input-available'];
  return t(meta.i18nKey);
}

interface ToolProps {
  part: ToolPart;
  name: string;
  className?: string;
}

export function Tool({ part, name, className }: ToolProps) {
  const { t } = useTranslation();
  const statusLabel = useToolStatusLabel(part.state);
  const inputSummary = summarizeToolInput(part.input);
  // Failures are expanded up front; successful calls stay collapsed so long
  // tool chains remain scannable in a narrow sidebar.
  const failed = part.state === 'output-error';

  return (
    <Collapsible
      defaultOpen={failed}
      className={cn(
        '@container rounded-lg border bg-muted/40 overflow-hidden w-full min-w-0',
        failed ? 'border-destructive/40' : 'border-border',
        className,
      )}
    >
      <CollapsibleTrigger className="group/tool gap-1.5 px-2 py-1.5 hover:bg-muted/70 transition-colors min-w-0">
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
        <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[0.6875rem] font-medium truncate shrink-0 max-w-[45%]">
          {name}
        </span>
        {inputSummary && (
          <span className="text-[0.6875rem] text-muted-foreground/70 truncate min-w-0 flex-1">
            {inputSummary}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 shrink-0 pl-1">
          <ToolStatusIcon state={part.state} />
          <span
            className={cn(
              'hidden @[16rem]:inline text-[0.625rem]',
              STATUS_META[part.state]?.className ?? 'text-muted-foreground',
            )}
          >
            {statusLabel}
          </span>
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t border-border/60 px-2 py-1.5 flex flex-col gap-1.5">
        <ToolInput input={part.input} />
        {part.state === 'output-error' ? (
          <ToolError message={part.errorText ?? t('sidebar.tool.unknownError')} />
        ) : part.state === 'output-available' ? (
          <ToolOutput output={part.output} />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

/** Scrollable, size-capped mono block. */
function ToolCodeBlock({ children }: { children: string }) {
  return (
    <pre className="max-h-40 overflow-auto scrollbar-lumo rounded-md bg-background/80 border border-border/60 p-1.5 text-[0.6875rem] leading-relaxed font-mono whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

export function ToolInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  if (input == null || (typeof input === 'object' && Object.keys(input).length === 0)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <ToolSectionLabel>{t('sidebar.tool.input')}</ToolSectionLabel>
      <ToolCodeBlock>{safeStringify(input)}</ToolCodeBlock>
    </div>
  );
}

export function ToolError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <ToolSectionLabel>{t('sidebar.tool.error')}</ToolSectionLabel>
      <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-1.5 text-[0.6875rem] text-destructive">
        <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
        <span className="break-words min-w-0">{message}</span>
      </div>
    </div>
  );
}

export function ToolOutput({ output }: { output: unknown }) {
  const { t } = useTranslation();
  const normalized = React.useMemo(() => normalizeToolOutput(output), [output]);

  if (normalized.kind === 'empty') return null;

  if (normalized.kind === 'error') {
    return <ToolError message={normalized.message} />;
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <ToolSectionLabel>{t('sidebar.tool.output')}</ToolSectionLabel>

      {normalized.kind === 'image' ? (
        <div className="flex flex-col gap-1 min-w-0">
          <img
            src={normalized.url}
            alt={t('sidebar.tool.screenshot')}
            className="max-h-48 w-full rounded-md border border-border/60 object-contain bg-background/80"
          />
          {normalized.caption && <ToolCodeBlock>{normalized.caption}</ToolCodeBlock>}
        </div>
      ) : (
        <>
          <ToolCodeBlock>{normalized.text}</ToolCodeBlock>
          {normalized.truncated && (
            <div className="text-[0.625rem] text-muted-foreground/70">
              {t('sidebar.tool.truncated', { count: normalized.totalLength })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

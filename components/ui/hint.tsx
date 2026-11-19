import * as React from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  tooltipSurfaceClass,
} from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { usePointerMode, type PointerMode } from '@/lib/use-pointer-mode';
import { cn } from '@/lib/utils';

/**
 * One supplemental surface, reachable by both kinds of pointer.
 *
 * ## Why this exists
 *
 * Radix's tooltip is hover-only by construction, and deliberately so: its
 * trigger ignores `pointermove` from touch, suppresses the focus-open that a
 * tap would cause (`isPointerDownRef`), and closes on the following click. On a
 * touchscreen that means a tooltip can never be opened — the token breakdown,
 * the context gauge and the exact message time were simply unreachable, even
 * though their only trigger was a button the user could see and tap.
 *
 * `Hint` keeps the tooltip where hover exists (same 300ms delay, same motion,
 * same grace area — nothing about the desktop experience changes) and switches
 * to a popover where it does not:
 *
 * | | hover pointer | touch pointer |
 * | --- | --- | --- |
 * | opens on | hover, focus | tap / Enter |
 * | closes on | leave, blur, Esc | tap again, outside tap, Esc |
 * | role | `tooltip` (describes the trigger) | `dialog` (owns content) |
 *
 * A popover is the right primitive for the touch case rather than a
 * "tooltip you can also tap": this content is what
 * `interest-triggered-tooltips` calls a **toggletip** — numbers the user wants
 * to inspect and scroll through — and ARIA tooltips may not contain
 * interactive or scrollable content. Radix's popover supplies the parts that
 * would otherwise be re-implemented by hand: portal, collision flip/shift,
 * light dismiss on outside pointer-down, and Escape.
 *
 * ## Rules the call site does not have to remember
 *
 * - **Never move focus into the panel.** Interest is not activation; the tap
 *   that opens the panel must leave focus on the trigger, otherwise the
 *   transcript jumps and WCAG 3.2.1 (On Focus) is failed. Radix focuses the
 *   content on mount, so that is prevented here, once.
 * - **Never hug the trigger's width.** `ui/popover` pins `PopoverContent` to
 *   `--radix-popover-trigger-width` because its other callers are anchored
 *   editors. These panels size to their content, so `w-auto` overrides it.
 * - **One available-height variable.** Radix namespaces the pinned popper's
 *   available height per primitive (`--radix-tooltip-content-available-height`
 *   vs `--radix-popover-content-available-height`), and `TokenUsageTooltip`
 *   clamps its step ledger to it. `Hint` publishes the mode-appropriate value
 *   as `--hint-available-height`, so a panel is written once for both surfaces.
 *
 * ## Provider
 *
 * `provider: 'own'` (default) gives the panel its own `TooltipProvider`. A
 * hoverable panel needs a grace area scoped to itself, and sharing one with a
 * neighbouring label makes Radix's in-transit flag swallow every trigger in
 * that provider. `provider: 'inherit'` is for a one-line label that should
 * share the row's skip-delay instead (the message timestamp). It is ignored in
 * tap mode, where no provider is involved.
 */
export type HintTrigger = React.ReactElement | ((mode: PointerMode) => React.ReactElement);

export interface HintProps {
  /** The control that reveals the panel; may differ per pointer mode. */
  trigger: HintTrigger;
  /** The panel's content. */
  children: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<typeof TooltipContent>['side'];
  align?: React.ComponentPropsWithoutRef<typeof TooltipContent>['align'];
  sideOffset?: number;
  collisionPadding?: React.ComponentPropsWithoutRef<typeof TooltipContent>['collisionPadding'];
  /** Extra classes for the panel, on top of the shared floating-surface chrome. */
  panelClassName?: string;
  /**
   * Accessible name for the tap-mode dialog. The content usually opens with a
   * visible heading, but that heading is not wired as a label, so name the
   * dialog here with the same string the trigger announces.
   */
  contentLabel?: string;
  provider?: 'own' | 'inherit';
  tooltipProviderProps?: Omit<
    React.ComponentPropsWithoutRef<typeof TooltipProvider>,
    'children'
  >;
}

const DEFAULT_SIDE = 'bottom';
const DEFAULT_ALIGN = 'center';
const DEFAULT_SIDE_OFFSET = 4;
const DEFAULT_COLLISION_PADDING = 8;

export function Hint({
  trigger,
  children,
  side = DEFAULT_SIDE,
  align = DEFAULT_ALIGN,
  sideOffset = DEFAULT_SIDE_OFFSET,
  collisionPadding = DEFAULT_COLLISION_PADDING,
  panelClassName,
  contentLabel,
  provider = 'own',
  tooltipProviderProps,
}: HintProps) {
  const mode = usePointerMode();
  const triggerNode = typeof trigger === 'function' ? trigger(mode) : trigger;

  // Resolved by CSS at use time, so the panel keeps one `max-h-[…]` class in
  // both modes even though Radix spells the variable differently per primitive.
  const availableHeight = {
    '--hint-available-height':
      mode === 'tap'
        ? 'var(--radix-popover-content-available-height)'
        : 'var(--radix-tooltip-content-available-height)',
  } as React.CSSProperties;

  if (mode === 'tap') {
    return (
      <Popover>
        <PopoverTrigger asChild>{triggerNode}</PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          aria-label={contentLabel}
          style={availableHeight}
          // Focus stays on the trigger; see "never move focus" above.
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={cn('w-auto popover-panel', tooltipSurfaceClass, panelClassName)}
        >
          {children}
        </PopoverContent>
      </Popover>
    );
  }

  const tooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{triggerNode}</TooltipTrigger>
      {/* Portalled and collision-aware inside `ui/tooltip`, so a toolbar at the
          bottom of the panel opens upward and nothing is clipped by the
          transcript scroller. */}
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={availableHeight}
        className={panelClassName}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );

  if (provider === 'inherit') return tooltip;

  return <TooltipProvider {...tooltipProviderProps}>{tooltip}</TooltipProvider>;
}

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * The one tooltip surface in the app.
 *
 * Before this file there were three near-identical implementations — the
 * message toolbar, the token usage panel and the composer's context ring — each
 * carrying its own provider, its own `delayDuration` (150 or 300) and its own
 * className, with two of them animating through `tailwindcss-animate` classes
 * that this project does not compile (`globals.css` says so explicitly), so
 * those tooltips appeared and vanished with no motion at all while dialogs and
 * popovers animated through CSS keyframes. Same component, three behaviours.
 *
 * Design decisions that belong to the *system*, not to a call site:
 *
 * - **Portal by default.** A tooltip rendered in place is clipped by the first
 *   `overflow: hidden` ancestor — the composer is one (`ChatInput` rounds its
 *   attachment strip), so the context ring's panel only half-rendered.
 * - **300ms delay.** Long enough that sweeping the pointer across a toolbar does
 *   not flash a trail of labels, short enough to feel like a response.
 * - **Motion from CSS.** `data-state` keyframes, same duration/easing family as
 *   `popover-panel`, so every floating surface settles at the same speed.
 *
 * A call site with genuinely different hover geometry (the token panel) still
 * owns its own provider so Radix's pointer "grace area" is scoped to that panel
 * — that is a behavioural need, not a styling one, and it passes
 * `disableHoverableContent` through the same component.
 */

const DEFAULT_DELAY_MS = 300;

export function TooltipProvider(
  props: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>,
) {
  return <TooltipPrimitive.Provider delayDuration={DEFAULT_DELAY_MS} {...props} />;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, side = 'bottom', sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'tooltip-panel z-50 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { TooltipPrimitive };

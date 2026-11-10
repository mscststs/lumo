import * as React from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { cjk } from '@streamdown/cjk';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@radix-ui/react-tooltip';
import { Button } from '@/components/ui/button';

// ─── Message ────────────────────────────────────────────────────────────────

interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  from: 'user' | 'assistant';
}

export function Message({ from, className, children, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        'group flex flex-col',
        from === 'user' ? 'is-user items-end' : 'is-assistant items-start',
        className,
      )}
      data-role={from}
      {...props}
    >
      {children}
    </div>
  );
}

// ─── MessageContent ─────────────────────────────────────────────────────────

interface MessageContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export function MessageContent({ className, children, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 text-sm',
        // User messages: bubble style with background
        'group-[.is-user]:max-w-[85%] group-[.is-user]:bg-chat-user group-[.is-user]:text-chat-user-foreground group-[.is-user]:rounded-2xl group-[.is-user]:px-3 group-[.is-user]:py-2',
        // Assistant messages: full-width, no background, flat design
        'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// ─── MessageResponse (Markdown renderer) ────────────────────────────────────

/**
 * Hoisted to module scope on purpose: `Streamdown` memoises on a referential
 * comparison of `plugins`, so an inline object literal would allocate a new
 * identity on every render and force the whole Markdown tree to re-parse.
 */
const STREAMDOWN_PLUGINS = { code, math, cjk };

const STREAMDOWN_ANIMATE_OPTIONS = { animation: "fadeIn" as const, duration: 80, stagger: 20, sep: "word" as const };

interface MessageResponseProps extends React.HTMLAttributes<HTMLDivElement> {
  children: string;
  isStreaming?: boolean;
}

export const MessageResponse = React.memo(function MessageResponse({
  children,
  isStreaming = false,
  className,
  ...props
}: MessageResponseProps) {
  return (
    <div className={cn('sd-message-response break-words overflow-hidden', className)} {...props}>
      <Streamdown
        animated={STREAMDOWN_ANIMATE_OPTIONS}
        plugins={STREAMDOWN_PLUGINS}
        isAnimating={isStreaming}
      >
        {children}
      </Streamdown>
    </div>
  );
});

// ─── MessageActions ─────────────────────────────────────────────────────────

interface MessageActionsProps extends React.HTMLAttributes<HTMLDivElement> {}

export function MessageActions({ className, children, ...props }: MessageActionsProps) {
  return (
    // One provider for the whole row: Radix's `skipDelayDuration` then applies
    // across the controls, so sliding from copy to delete opens the second
    // tooltip instantly instead of restarting the 300ms wait per button (which
    // is what a provider per `MessageAction` used to do). Everything in the row
    // that shows a plain-text tooltip must live inside this.
    //
    // `disableHoverableContent`: a one-line label has nothing to hover into, so
    // leaving the trigger closes it outright. That also keeps Radix's pointer
    // grace area — `isPointerInTransitRef`, which suppresses *every* trigger of
    // the provider while the pointer is "in flight" — out of the row entirely.
    // A hoverable neighbour (the token panel) owns its own provider for exactly
    // that reason; see `TokenUsageTooltip`.
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <div
        className={cn(
          'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity pt-1',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </TooltipProvider>
  );
}

// ─── Message toolbar chrome ─────────────────────────────────────────────────

/**
 * The shared hit-area/feedback chrome of every message-toolbar control.
 *
 * Buttons add their own width (`w-6`), the timestamp is as wide as its label,
 * but the height, the radius, the muted-to-foreground hover and the accent
 * wash behind the pointer are identical by construction — the row reads as one
 * coherent strip rather than "three buttons and a caption".
 */
export const messageToolbarTriggerClass =
  'h-6 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

/**
 * The single plain-text tooltip surface for the message toolbar.
 *
 * Portalled to `body` because the transcript scroller (`overflow-y-auto`) clips
 * anything inline below the last visible row, and because the `motion.div`
 * entry animation sets a `transform`, which captures a non-portalled popper and
 * misplaces it. Radix still flips/shifts against the viewport, so a toolbar at
 * the very bottom of the sidepanel opens its label upward instead of clipping.
 */
export function MessageToolbarTooltipContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipContent>) {
  return (
    <TooltipPortal>
      <TooltipContent
        side="bottom"
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          'z-50 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm',
          'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    </TooltipPortal>
  );
}

// ─── MessageAction ──────────────────────────────────────────────────────────

interface MessageActionProps {
  label: string;
  tooltip?: string;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function MessageAction({
  label,
  tooltip,
  onClick,
  children,
  className,
}: MessageActionProps) {
  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(messageToolbarTriggerClass, 'w-6', className)}
      onClick={onClick}
      aria-label={label}
    >
      {children}
    </Button>
  );

  // The provider is supplied once by `MessageActions`; the trigger and the
  // content are shared with the timestamp so every label in the row is the same
  // surface, delay, placement and animation.
  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <MessageToolbarTooltipContent>{tooltip}</MessageToolbarTooltipContent>
      </Tooltip>
    );
  }

  return button;
}

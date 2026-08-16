import * as React from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { cjk } from '@streamdown/cjk';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
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
    <div
      className={cn(
        'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity pt-1',
        className,
      )}
      {...props}
    >
      {children}
    </div>
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
      className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', className)}
      onClick={onClick}
      aria-label={label}
    >
      {children}
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="rounded-md bg-popover text-popover-foreground px-2 py-1 text-xs border shadow-sm"
          >
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
}

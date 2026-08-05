import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Modal dialog built on `@radix-ui/react-dialog`.
 *
 * Replaces the hand-rolled `fixed inset-0` overlays the options pages used to
 * ship: Radix supplies the focus trap, Esc handling, scroll lock and
 * `aria-modal` wiring that those were missing.
 *
 * Enter/exit motion is delegated to CSS keyframes via Radix's `data-state`
 * attributes rather than `motion`, so the component can unmount without an
 * `AnimatePresence` wrapper at every call site.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // `bg-overlay` is a per-theme token, not a `foreground` tint: on the dark
      // palettes `foreground` is near-white, so `bg-foreground/40` produced a
      // white wash that lightened the page instead of dimming it.
      'fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] dialog-overlay',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Render the built-in top-right close button. Defaults to true. */
  showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, showCloseButton = true, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    {/*
      Centring is done by this flex wrapper rather than the usual
      `top-1/2 left-1/2 -translate-1/2` trick.

      In Tailwind v4 `-translate-x-1/2` compiles to the standalone `translate`
      property, not to `transform: translate(...)`. A keyframe animating
      `transform` therefore does not override it — the two *compose*, so the
      panel started at -100%/-100% (up and left of the viewport) and snapped to
      its real position only when the animation ended. Centring via layout means
      the animation only has to touch opacity and scale.

      `pointer-events-none` keeps the wrapper from swallowing backdrop clicks;
      the panel re-enables them for itself.
    */}
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'pointer-events-auto flex w-full max-w-md flex-col gap-4',
          'rounded-xl border border-border bg-card p-5 shadow-xl',
          'max-h-[calc(100dvh-4rem)] overflow-y-auto scrollbar-lumo dialog-content',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            className="absolute right-3.5 top-3.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </div>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 pr-8', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold leading-tight text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs leading-relaxed text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
};

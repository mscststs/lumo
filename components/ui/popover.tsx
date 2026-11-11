import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Slot } from '@radix-ui/react-slot';
import { RemoveScroll } from 'react-remove-scroll';
import { cn } from '@/lib/utils';

/**
 * Anchored floating panel built on `@radix-ui/react-popover`.
 *
 * The counterpart to `Dialog` for surfaces that must stay attached to a
 * trigger: portal, collision detection (flip/shift) and outside-dismiss are
 * supplied by Radix, so a caller never has to reason about the `overflow-y-auto`
 * dialog it lives in clipping the panel.
 *
 * Visuals and motion mirror `SelectContent` on purpose — same border/radius
 * tokens, same `popover-panel` keyframes keyed off `data-state` — so a popover
 * and a select menu read as one system.
 *
 * The panel carries its own `RemoveScroll` lock for the same reason
 * `SelectContent` does: it is portal'd to `body`, so it lives outside the lock
 * node of any modal dialog it opens inside. The dialog's lock treats every wheel
 * event outside itself as "scroll the page" and cancels it, which silently
 * disables scrolling inside the panel. Registering the panel as its own lock
 * lets its wheel events resolve against its own scrollable area instead.
 *
 * `pointer-events: auto` is the other half of the same problem. A modal dialog
 * sets `pointer-events: none` on `body` and re-enables it on its own layer; a
 * portal'd panel is a *different* layer, so it inherits `none` and is not a hit
 * test target at all — no hover, no wheel, no clicks. Radix's own
 * `SelectContent` gets this for free because its `DismissableLayer` shares one
 * module-level layer stack with the dialog; a separately pinned
 * `@radix-ui/react-dismissable-layer` (as `@radix-ui/react-popover` ships) does
 * not, so the panel states it explicitly.
 */

const Popover = PopoverPrimitive.Root;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, style, align = 'start', side = 'bottom', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <RemoveScroll as={Slot} allowPinchZoom>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md border bg-popover text-popover-foreground shadow-md outline-none popover-panel',
          // The panel is anchored to the control it describes, so it tracks the
          // anchor's width instead of hugging its own content. Radix re-exports
          // the anchor's width under this popover-scoped custom property.
          'w-[var(--radix-popover-trigger-width)]',
          className,
        )}
        // Merged rather than assigned so a caller's own style survives.
        style={{ pointerEvents: 'auto', ...style }}
        {...props}
      />
    </RemoveScroll>
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverContent };

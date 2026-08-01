import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Minimal collapsible primitive.
 *
 * The upstream ai-elements `Tool` builds on `@radix-ui/react-collapsible`, but
 * this project animates disclosure with motion (see options/McpSettings) and
 * globally strips focus rings, so a Radix dependency would add weight without
 * benefit. This keeps the same compound-component API surface.
 */

interface CollapsibleContextValue {
  open: boolean;
  toggle: () => void;
  contentId: string;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

function useCollapsible(component: string): CollapsibleContextValue {
  const context = React.useContext(CollapsibleContext);
  if (!context) {
    throw new Error(`<${component}> must be used inside <Collapsible>`);
  }
  return context;
}

interface CollapsibleProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onToggle'> {
  /** Uncontrolled initial state. */
  defaultOpen?: boolean;
  /** Controlled state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Collapsible({
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
  children,
  ...props
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const reactId = React.useId();

  const toggle = React.useCallback(() => {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [open, isControlled, onOpenChange]);

  const value = React.useMemo(
    () => ({ open, toggle, contentId: `collapsible-${reactId}` }),
    [open, toggle, reactId],
  );

  return (
    <CollapsibleContext.Provider value={value}>
      <div className={cn('flex flex-col', className)} data-state={open ? 'open' : 'closed'} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({
  className,
  children,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle, contentId } = useCollapsible('CollapsibleTrigger');

  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      data-state={open ? 'open' : 'closed'}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggle();
      }}
      className={cn('flex w-full items-center text-left', className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function CollapsibleContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { open, contentId } = useCollapsible('CollapsibleContent');

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={contentId}
          key="content"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          <div className={cn(className)} {...props}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

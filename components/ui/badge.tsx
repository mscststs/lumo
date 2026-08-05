import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Compact status/metadata pill.
 *
 * The options pages had this inlined as `text-xs bg-primary/10 text-primary
 * px-1.5 py-0.5 rounded` in several places; centralising it keeps the tint
 * ratios consistent across the three themes.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap',
  {
    variants: {
      variant: {
        /** Neutral metadata — provider transport, counts. */
        default: 'border-transparent bg-muted text-muted-foreground',
        /** Highlighted capability — e.g. vision support. */
        accent: 'border-primary/20 bg-primary/10 text-primary',
        /** Problems that need the user's attention. */
        destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
        /** Low-emphasis label that still needs an edge to read as a chip. */
        outline: 'border-border bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

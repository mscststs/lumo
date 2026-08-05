import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Title + description block shared by every options subpage.
 *
 * All six pages had this markup duplicated verbatim; centralising it means the
 * page rhythm can be tuned in one place, and `actions` gives a page-level
 * primary button a consistent home instead of floating below the content.
 */
export function SettingsHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  /** Page-level actions, right-aligned on wide layouts and wrapped below on narrow ones. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * One label/description → control row, the shape every settings page uses.
 *
 * Alignment follows the description: with one there is a block of text to align
 * the control against, so both start at the top; without one the row is a single
 * line and centring reads better.
 */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex justify-between gap-4',
        description ? 'items-start' : 'items-center',
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <Label className="text-sm">{label}</Label>
        {description && (
          <span className="text-xs text-muted-foreground break-words">{description}</span>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

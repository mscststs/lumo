import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Form field wrapper: label + control + hint + validation message.
 *
 * The options forms previously repeated `<div><Label/><Input className="mt-1"/></div>`
 * at every field, which meant no `htmlFor`/`aria-describedby` wiring and no
 * place to surface a per-field error. `Field` generates the ids and hands them
 * to the control through a render prop, so accessibility comes for free and a
 * failed save can point at the offending input instead of silently no-op'ing.
 *
 * @example
 * <Field label={t('...apiKey')} error={errors.apiKey}>
 *   {(props) => <Input {...props} type="password" value={v} onChange={...} />}
 * </Field>
 */

/** Props a `Field` injects into its control. */
export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': boolean | undefined;
}

interface FieldProps {
  label: React.ReactNode;
  /** Static guidance, rendered below the control. Replaced by `error` when set. */
  hint?: React.ReactNode;
  /** Validation message. Its presence marks the control invalid. */
  error?: string;
  /** Marks the label with a required affordance. */
  required?: boolean;
  className?: string;
  children: (props: FieldControlProps) => React.ReactNode;
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const reactId = React.useId();
  const controlId = `field-${reactId}`;
  const hintId = `${controlId}-hint`;
  // Only one message shows at a time, so a single describedby target is enough.
  const messageId = hint || error ? hintId : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={controlId} className="text-xs text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>

      {children({
        id: controlId,
        'aria-describedby': messageId,
        'aria-invalid': error ? true : undefined,
      })}

      {error ? (
        <p id={hintId} className="flex items-start gap-1 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs leading-relaxed text-muted-foreground break-words">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/**
 * Row layout for a labelled toggle: text block on the left, control on the right.
 * Kept separate from `Field` because a switch owns its own label association
 * through `id` and needs no hint slot below the control.
 */
export function FieldToggleRow({
  label,
  description,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Receives the generated id so the control can be `htmlFor`-linked. */
  children: (props: { id: string }) => React.ReactNode;
  className?: string;
}) {
  const reactId = React.useId();
  const controlId = `toggle-${reactId}`;

  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <Label htmlFor={controlId} className="text-sm">
          {label}
        </Label>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground break-words">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0 pt-0.5">{children({ id: controlId })}</div>
    </div>
  );
}

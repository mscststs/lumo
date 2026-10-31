import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { validateExtension, type ExtensionField, type ValidationErrors } from './validation';

interface ExtensionDialogProps {
  /** The draft to add. `null` closes the dialog. */
  draft: { id: string } | null;
  /** Providers already configured, so a double add is rejected up front. */
  configured: readonly string[];
  onSave: (id: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Add-extension-service dialog.
 *
 * One field, but it gets the same frame as its sibling dialog: a lone inline
 * input under the section heading gave the two "add" flows different shapes for
 * no reason.
 */
export function ExtensionDialog({ draft, configured, onSave, onClose }: ExtensionDialogProps) {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [errors, setErrors] = useState<ValidationErrors<ExtensionField>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setId(draft?.id ?? '');
    setErrors({});
  }, [draft]);

  if (!draft) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateExtension(id, configured);
    if (found.id) {
      setErrors(found);
      return;
    }

    setSaving(true);
    try {
      await onSave(id.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // Title-only dialog: state that instead of shipping filler copy.
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('options.mcp.extensions.add')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field
            label={t('options.mcp.extensions.idLabel')}
            error={errors.id && t(errors.id)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={id}
                onChange={(event) => {
                  setId(event.target.value);
                  if (errors.id) setErrors({});
                }}
                placeholder={t('options.mcp.extensions.idPlaceholder')}
                dir="ltr"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('options.mcp.extensions.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

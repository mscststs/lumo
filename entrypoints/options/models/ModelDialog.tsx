import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldToggleRow } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { ModelConfig } from '@/types';
import {
  hasErrors,
  normalizeModelDraft,
  validateModel,
  type ModelField,
  type ValidationErrors,
} from './validation';

interface ModelDialogProps {
  /** The draft to edit. `null` closes the dialog. */
  draft: ModelConfig | null;
  /** Whether `draft` already exists, which selects the title copy. */
  isExisting: boolean;
  /** Name of the owning provider, shown so the user knows where it lands. */
  providerName: string;
  /** Models already on this provider, for the duplicate-id check. */
  siblings: ModelConfig[];
  onSave: (model: ModelConfig) => Promise<void>;
  onClose: () => void;
}

export function ModelDialog({
  draft,
  isExisting,
  providerName,
  siblings,
  onSave,
  onClose,
}: ModelDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ModelConfig | null>(draft);
  const [errors, setErrors] = useState<ValidationErrors<ModelField>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(draft);
    setErrors({});
  }, [draft]);

  if (!value) return null;

  const patch = (changes: Partial<ModelConfig>, clears?: ModelField) => {
    setValue({ ...value, ...changes });
    if (clears && errors[clears]) setErrors((prev) => ({ ...prev, [clears]: undefined }));
  };

  const handleSave = async () => {
    const normalized = normalizeModelDraft(value);
    const found = validateModel(normalized, siblings);
    if (hasErrors(found)) {
      setErrors(found);
      return;
    }
    setSaving(true);
    try {
      await onSave(normalized);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const dialog = event.currentTarget as HTMLElement;
          dialog.querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isExisting ? t('options.models.editModel') : t('options.models.addModel')}
          </DialogTitle>
          {/* Not a DialogDescription: the provider name is an identifier, and
              wiring it to aria-describedby would read as prose guidance. */}
          <p className="truncate text-xs text-muted-foreground">{providerName}</p>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            label={t('options.models.modelId')}
            hint={t('options.models.modelIdHint')}
            error={errors.modelId && t(errors.modelId)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={value.modelId}
                onChange={(e) => {
                  const modelId = e.target.value;
                  // Mirror the id into an empty display name: for most models
                  // the id *is* the label the user wants, and this removes the
                  // most common reason a save was rejected.
                  const shouldMirror = !value.displayName || value.displayName === value.modelId;
                  patch(
                    shouldMirror ? { modelId, displayName: modelId } : { modelId },
                    'modelId',
                  );
                  if (shouldMirror && errors.displayName) {
                    setErrors((prev) => ({ ...prev, displayName: undefined }));
                  }
                }}
                placeholder={t('options.models.modelIdPlaceholder')}
                spellCheck={false}
                className="font-mono text-xs"
              />
            )}
          </Field>

          <Field
            label={t('options.models.modelName')}
            error={errors.displayName && t(errors.displayName)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={value.displayName}
                onChange={(e) => patch({ displayName: e.target.value }, 'displayName')}
                placeholder={t('options.models.modelNamePlaceholder')}
              />
            )}
          </Field>

          <FieldToggleRow
            label={t('options.models.isVision')}
            description={t('options.models.isVisionDesc')}
            className="rounded-lg border border-border bg-muted/40 p-3"
          >
            {({ id }) => (
              <Switch
                id={id}
                checked={value.isVision}
                onCheckedChange={(isVision) => patch({ isVision })}
              />
            )}
          </FieldToggleRow>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

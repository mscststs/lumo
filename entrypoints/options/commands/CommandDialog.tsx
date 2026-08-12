import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { Textarea } from '@/components/ui/textarea';
import {
  conflictingCommandNames,
  normalizeCommandName,
  validateCommandName,
  type CommandSettings,
  type UserCommand,
} from '@/lib/slash-commands';

interface CommandDialogProps {
  /** The draft to edit. `null` closes the dialog. */
  draft: UserCommand | null;
  /** Whether `draft` already exists on the list. */
  isExisting: boolean;
  settings: CommandSettings;
  onSave: (command: UserCommand) => Promise<void>;
  onClose: () => void;
}

/**
 * Name/phrase editor for a custom command.
 *
 * Enablement is deliberately absent here: a command is switched on or off from
 * the list, the same place its siblings' toggles live. The dialog only shapes
 * what the trigger *does* — name and expansion — and preserves the command's
 * current `enabled` flag untouched (a new command starts enabled).
 */
export function CommandDialog({
  draft,
  isExisting,
  settings,
  onSave,
  onClose,
}: CommandDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<UserCommand | null>(draft);
  const [nameError, setNameError] = useState<string | undefined>();
  const [phraseError, setPhraseError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(draft);
    setNameError(undefined);
    setPhraseError(undefined);
  }, [draft]);

  const conflicts = useMemo(() => {
    if (!value?.enabled) return [];
    return conflictingCommandNames(settings, value.name, {
      kind: 'user',
      id: value.id,
    });
  }, [settings, value]);

  if (!value) return null;

  const handleSave = async () => {
    const name = normalizeCommandName(value.name);
    const phrase = value.phrase.trim();
    const nameProblem = validateCommandName(name);
    const nextNameError = nameProblem
      ? t(`options.commands.errors.${nameProblem}`)
      : undefined;
    const nextPhraseError = phrase
      ? undefined
      : t('options.commands.errors.phraseRequired');

    setNameError(nextNameError);
    setPhraseError(nextPhraseError);
    if (nextNameError || nextPhraseError) return;

    setSaving(true);
    try {
      await onSave({ ...value, name, phrase });
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
            {isExisting ? t('options.commands.editCommand') : t('options.commands.addCommand')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            label={t('options.commands.name')}
            hint={t('options.commands.nameHint')}
            error={nameError}
            required
          >
            {(props) => (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 font-mono text-sm text-muted-foreground">/</span>
                <Input
                  {...props}
                  value={value.name}
                  onChange={(e) => {
                    setValue({ ...value, name: e.target.value });
                    if (nameError) setNameError(undefined);
                  }}
                  placeholder={t('options.commands.namePlaceholder')}
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </div>
            )}
          </Field>

          <Field
            label={t('options.commands.phrase')}
            hint={t('options.commands.phraseHint')}
            error={phraseError}
            required
          >
            {(props) => (
              <Textarea
                {...props}
                value={value.phrase}
                onChange={(e) => {
                  setValue({ ...value, phrase: e.target.value });
                  if (phraseError) setPhraseError(undefined);
                }}
                placeholder={t('options.commands.phrasePlaceholder')}
                rows={3}
                className="min-h-[72px] resize-y text-sm"
              />
            )}
          </Field>

          {conflicts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('options.commands.conflictHint', {
                names: conflicts.map((name) => `/${name}`).join(', '),
              })}
            </p>
          )}
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

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { McpHttpServerConfig } from '@/lib/mcp/types';
import {
  hasErrors,
  headersToText,
  normalizeServerDraft,
  parseHeaderLines,
  validateServer,
  type ServerField,
  type ValidationErrors,
} from './validation';

interface ServerDialogProps {
  /** The draft to add. `null` closes the dialog. */
  draft: McpHttpServerConfig | null;
  onSave: (config: McpHttpServerConfig) => Promise<void>;
  onClose: () => void;
}

/**
 * Add-external-server dialog.
 *
 * Occupies no space in the list until it opens, which is the point of moving this
 * form out of the page: adding a server used to push every existing card down
 * and made the user scroll to find the fields. Header text is local state and is
 * parsed on save, so the stored record never carries a half-typed line.
 */
export function ServerDialog({ draft, onSave, onClose }: ServerDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<McpHttpServerConfig | null>(draft);
  const [headersText, setHeadersText] = useState('');
  const [errors, setErrors] = useState<ValidationErrors<ServerField>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed whenever a different draft is opened so a previous attempt's errors
  // or leftover headers never leak into the next session.
  useEffect(() => {
    setValue(draft);
    setHeadersText(headersToText(draft?.headers));
    setErrors({});
    setSubmitError(null);
  }, [draft]);

  if (!value) return null;

  const patch = (changes: Partial<McpHttpServerConfig>, clears?: ServerField) => {
    setValue({ ...value, ...changes });
    if (clears && errors[clears]) setErrors((prev) => ({ ...prev, [clears]: undefined }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const withHeaders = { ...value, headers: parseHeaderLines(headersText) };
    const found = validateServer(withHeaders);
    if (hasErrors(found)) {
      setErrors(found);
      return;
    }

    setSaving(true);
    setSubmitError(null);
    try {
      await onSave(normalizeServerDraft(withHeaders));
      onClose();
    } catch (err) {
      // Registration failures are surfaced on the card itself (the server is
      // stored either way), so only a failed storage write lands here.
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // The dialog is a pure form: no description line, so the title is the
        // only copy. Declaring that explicitly silences Radix's a11y warning.
        aria-describedby={undefined}
        // Radix would focus the close button; aim at the name field so typing
        // starts immediately (same rule as the provider dialog).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('options.mcp.addServer')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field
            label={t('options.mcp.serverName')}
            error={errors.name && t(errors.name)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={value.name}
                onChange={(e) => patch({ name: e.target.value }, 'name')}
                placeholder={t('options.mcp.serverNamePlaceholder')}
              />
            )}
          </Field>

          {/* Replaces the old pair of side-by-side cards: the description now
              rides in the field's hint, so the dialog keeps the same form rhythm
              as the provider editor. */}
          <Field
            label={t('options.mcp.serverType')}
            hint={
              value.transport === 'http-stream'
                ? t('options.mcp.httpStreamDesc')
                : t('options.mcp.sseDesc')
            }
          >
            {({ id, 'aria-describedby': describedBy }) => (
              <Select
                value={value.transport}
                onValueChange={(next) =>
                  patch({ transport: next as McpHttpServerConfig['transport'] })
                }
              >
                <SelectTrigger id={id} aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http-stream">{t('options.mcp.httpStream')}</SelectItem>
                  <SelectItem value="sse">{t('options.mcp.sse')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field label={t('options.mcp.serverUrl')} error={errors.url && t(errors.url)} required>
            {(props) => (
              <Input
                {...props}
                type="url"
                value={value.url}
                onChange={(e) => patch({ url: e.target.value }, 'url')}
                placeholder={t('options.mcp.serverUrlPlaceholder')}
                dir="ltr"
                spellCheck={false}
                className="font-mono text-xs"
              />
            )}
          </Field>

          <Field label={t('options.mcp.serverDescription')}>
            {(props) => (
              <Input
                {...props}
                value={value.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder={t('options.mcp.serverDescriptionPlaceholder')}
              />
            )}
          </Field>

          <Field label={t('options.mcp.headers')} hint={t('options.mcp.headersPlaceholder')}>
            {(props) => (
              <Textarea
                {...props}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={`Authorization: Bearer <token>`}
                dir="ltr"
                rows={2}
                spellCheck={false}
                className="min-h-[60px] resize-y font-mono text-xs"
              />
            )}
          </Field>

          {submitError && (
            <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="break-words">{submitError}</span>
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('options.mcp.addServer')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

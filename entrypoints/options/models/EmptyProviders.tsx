import { useTranslation } from 'react-i18next';
import { Plus, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * First-run state for the models page.
 *
 * The previous version was a bare line of muted text above a button, which read
 * as an error rather than an invitation. A dashed panel with the primary action
 * inside it makes the next step unambiguous.
 */
export function EmptyProviders({ onAddProvider }: { onAddProvider: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Server className="h-5 w-5" aria-hidden />
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-medium text-foreground">{t('options.models.noProviders')}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('options.models.noProvidersDesc')}
        </p>
      </div>
      <Button size="sm" onClick={onAddProvider} className="gap-1.5">
        <Plus className="h-4 w-4" />
        {t('options.models.addProvider')}
      </Button>
    </div>
  );
}

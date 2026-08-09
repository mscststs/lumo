import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsGroup } from './components/SettingsGroup';
import { SettingsHeader } from './components/SettingsHeader';
import { AboutIdentity } from './about/AboutIdentity';
import { AboutLinks } from './about/AboutLinks';
import { StorageUsageCard } from './about/StorageUsageCard';
import { useStorageUsage } from './about/useStorageUsage';

/**
 * Version, install channel, links, and what Lumo's data costs.
 *
 * Grouped on one page because all three answer the same class of question — the
 * ones a user asks when reporting a bug or wondering where their disk went, and
 * which no other settings page could answer.
 */
export function AboutPage() {
  const { t } = useTranslation();
  const usage = useStorageUsage();

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.about.title')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void usage.refresh()}
            disabled={usage.loading}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${usage.loading ? 'animate-spin' : ''}`} />
            {t('options.about.refresh')}
          </Button>
        }
      />

      <div className="space-y-8">
        <AboutIdentity />

        <SettingsGroup title={t('options.about.groupLinks')}>
          <AboutLinks />
        </SettingsGroup>

        <SettingsGroup title={t('options.about.storage.title')}>
          <StorageUsageCard {...usage} />
        </SettingsGroup>
      </div>
    </div>
  );
}

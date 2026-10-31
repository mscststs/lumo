import { DirectionProvider } from '@radix-ui/react-direction';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { localeDirection } from '@/i18n/locales';

/**
 * Feeds the active text direction to every Radix primitive.
 *
 * `<html dir>` alone is enough for CSS logical properties, but Radix computes
 * submenu side, arrow-key navigation and collision handling from its own
 * direction context, which defaults to `ltr`. Without this wrapper an Arabic
 * user gets a right-to-left page whose dropdowns still open leftwards and whose
 * arrow keys still move the wrong way.
 */
export function AppDirection({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <DirectionProvider dir={localeDirection(i18n.language)}>{children}</DirectionProvider>
  );
}

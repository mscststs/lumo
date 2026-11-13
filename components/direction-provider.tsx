import { DirectionProvider } from '@radix-ui/react-direction';
import { MotionConfig } from 'motion/react';
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
 *
 * It is also where motion honours the OS "reduce motion" preference.
 * `reducedMotion="user"` makes every `motion.*` component skip transforms and
 * only animate opacity, matching the `prefers-reduced-motion` guard the CSS
 * keyframes already carry. Before this, 24 files animated regardless of the
 * setting because Motion does not read the media query on its own, and adding
 * `useReducedMotion` at each call site would have been the same fact written 24
 * times.
 */
export function AppDirection({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <DirectionProvider dir={localeDirection(i18n.language)}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </DirectionProvider>
  );
}

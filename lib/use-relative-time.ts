import { useTranslation } from 'react-i18next';

/**
 * Coarse relative timestamp ("3h ago"). Intl.RelativeTimeFormat keeps this
 * localized without pulling in a date library.
 */
export function useRelativeTime() {
  const { i18n } = useTranslation();

  return (timestamp: number): string => {
    const formatter = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' });
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const thresholds: [limit: number, unit: Intl.RelativeTimeFormatUnit, perUnit: number][] = [
      [60, 'second', 1],
      [3600, 'minute', 60],
      [86400, 'hour', 3600],
      [604800, 'day', 86400],
      [2629800, 'week', 604800],
      [31557600, 'month', 2629800],
    ];

    const magnitude = Math.abs(seconds);
    for (const [limit, unit, perUnit] of thresholds) {
      if (magnitude < limit) {
        return formatter.format(Math.round(seconds / perUnit), unit);
      }
    }
    return formatter.format(Math.round(seconds / 31557600), 'year');
  };
}

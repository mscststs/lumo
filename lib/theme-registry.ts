/**
 * Theme registry — the single source of truth for which themes exist.
 *
 * Deliberately free of React and storage imports: `store/storage-schema` needs
 * `normalizeTheme` to sanitise persisted values, while `lib/theme` (the React
 * layer) imports storage. Keeping the registry here breaks that cycle.
 */

import type { ResolvedTheme, Theme } from '@/types';

/**
 * `dark: true` makes the `.dark` variant (and the Shiki dark overrides in
 * globals.css) apply, so a new dark palette inherits the whole dark-mode
 * treatment and only has to override the tokens it actually changes.
 *
 * `labelKey` lives here rather than in the settings UI so a theme can never
 * ship with a hard-coded English label: the record is keyed by `ResolvedTheme`,
 * so TypeScript rejects a union extension until a label is supplied.
 */
export const THEMES: Record<ResolvedTheme, { dark: boolean; labelKey: string }> = {
  light: { dark: false, labelKey: 'options.ui.themeLight' },
  dark: { dark: true, labelKey: 'options.ui.themeDark' },
  midnight: { dark: true, labelKey: 'options.ui.themeMidnight' },
};

/** Selectable options in display order, `system` last as the "no opinion" pick. */
export const THEME_OPTIONS: { value: Theme; labelKey: string }[] = [
  ...(Object.keys(THEMES) as ResolvedTheme[]).map((value) => ({
    value: value as Theme,
    labelKey: THEMES[value].labelKey,
  })),
  { value: 'system', labelKey: 'options.ui.themeSystem' },
];

/** Theme used when nothing valid is stored. */
export const DEFAULT_THEME: Theme = 'system';

/** Palette applied for `system` when the OS asks for dark. */
export const SYSTEM_DARK_THEME: ResolvedTheme = 'dark';

/**
 * Coerce an arbitrary persisted value into a known theme.
 *
 * Guards two real cases: a config exported by a newer build that knows a theme
 * this build does not, and a config predating the field entirely. Without this
 * an unknown string would land in `data-theme`, match no token block, and leave
 * the UI on light tokens with no way to tell why.
 */
export function normalizeTheme(value: unknown): Theme {
  if (value === 'system') return 'system';
  if (typeof value === 'string' && value in THEMES) return value as Theme;
  return DEFAULT_THEME;
}

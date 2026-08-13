import type { FontSize } from '@/types';

/**
 * All recognized font-size presets, smallest to largest.
 *
 * Chrome uses 9 steps from Very Small to Very Large. We use a narrower range
 * suited to a sidebar: the 300–400px panel width means sub-12px is unreadable
 * and 18px+ wastes space.
 */
export const FONT_SIZE_OPTIONS: { value: FontSize; labelKey: string }[] = [
  { value: 12, labelKey: 'options.ui.fontSizeVerySmall' },
  { value: 13, labelKey: 'options.ui.fontSizeSmall' },
  { value: 14, labelKey: 'options.ui.fontSizeMedium' },
  { value: 15, labelKey: 'options.ui.fontSizeMediumLarge' },
  { value: 16, labelKey: 'options.ui.fontSizeDefault' },
  { value: 17, labelKey: 'options.ui.fontSizeLarge' },
  { value: 18, labelKey: 'options.ui.fontSizeVeryLarge' },
];

export const DEFAULT_FONT_SIZE: FontSize = 16;

const VALID_SIZES = new Set<number>(FONT_SIZE_OPTIONS.map((o) => o.value));

/**
 * Normalize a raw value to a valid font size. Falls back to the default if the
 * value is missing, non-numeric, or outside the allowed set.
 */
export function normalizeFontSize(raw: unknown): FontSize {
  if (typeof raw === 'number' && VALID_SIZES.has(raw)) {
    return raw as FontSize;
  }
  return DEFAULT_FONT_SIZE;
}

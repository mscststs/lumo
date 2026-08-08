import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MAX_PASTE_THRESHOLD,
  PASTE_ALWAYS,
  PASTE_NEVER,
  PASTE_THRESHOLD_PRESETS,
  isPasteThresholdPreset,
} from '@/lib/paste-threshold';

/** Sentinel select value; not a threshold, so it cannot collide with one. */
const CUSTOM = 'custom';

/**
 * Labels for the two presets that do not read as a character count. The rest are
 * rendered from the number itself, and the list of presets is taken from
 * `PASTE_THRESHOLD_PRESETS` so the dropdown cannot drift from the check that
 * decides whether a stored value counts as custom.
 */
const PRESET_LABEL_KEYS: Record<number, string> = {
  [PASTE_NEVER]: 'options.ui.pasteThresholdNever',
  [PASTE_ALWAYS]: 'options.ui.pasteThresholdAlways',
};

/**
 * Picks the character count at which a pasted block becomes an attachment.
 *
 * The presets and a free-form count share one stored number, so the dropdown
 * shows "Custom" exactly when the stored value is not a preset. A typed value is
 * committed on blur or Enter rather than per keystroke: mid-typing "2" of "2500"
 * is a valid but wildly different threshold, and persisting it would briefly put
 * the composer in a state the user never asked for.
 */
export function PasteThresholdField({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const isPreset = isPasteThresholdPreset(value);
  const [isCustom, setIsCustom] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? '' : String(value));

  // The stored value arrives asynchronously, so a custom one has to switch the
  // control into custom mode after the first render. Keyed on `isPreset` rather
  // than on `value` so it cannot fight the draft while the user types: a
  // half-typed number is never committed, hence never changes `value`.
  useEffect(() => {
    if (!isPreset) {
      setIsCustom(true);
      setDraft(String(value));
    }
  }, [isPreset]);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setIsCustom(true);
      // Seed the box with what is in effect, so leaving it untouched is a no-op.
      setDraft(String(value));
      return;
    }
    setIsCustom(false);
    onChange(Number(next));
  };

  /** Commits the typed count, ignoring anything that is not a usable length. */
  const commitDraft = () => {
    const parsed = Math.trunc(Number(draft));
    if (!Number.isFinite(parsed) || parsed < PASTE_ALWAYS) {
      // Snap back to what is actually stored rather than silently keeping an
      // unusable number on screen as if it had taken effect.
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(parsed, MAX_PASTE_THRESHOLD);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="flex items-center gap-2">
      {isCustom && (
        <Input
          type="number"
          min={PASTE_ALWAYS}
          max={MAX_PASTE_THRESHOLD}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          aria-label={t('options.ui.pasteThresholdCustom')}
          className="w-24 text-sm"
        />
      )}
      <Select value={isCustom ? CUSTOM : String(value)} onValueChange={handleSelect}>
        <SelectTrigger className="w-40" aria-label={t('options.ui.pasteThreshold')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PASTE_THRESHOLD_PRESETS.map((preset) => (
            <SelectItem key={preset} value={String(preset)}>
              {PRESET_LABEL_KEYS[preset]
                ? t(PRESET_LABEL_KEYS[preset])
                : t('options.ui.pasteThresholdChars', { chars: preset })}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{t('options.ui.pasteThresholdCustom')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

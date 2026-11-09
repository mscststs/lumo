/**
 * Message-toolbar visibility, the single place the defaults and their
 * normalisation live.
 *
 * Three surfaces read this record — the options page, the storage schema's
 * normaliser, and `useMessageDisplaySettings` — and each used to restate the
 * defaults. With `time` added, a partial record from an older install
 * (`{ copy, regenerate, delete, usage }` without `time`) would resolve to
 * `undefined` at the bubble and silently hide the timestamp, so the merge
 * belongs here rather than at every reader.
 *
 * Free of i18next and browser APIs: `store/storage-schema.ts` imports it on the
 * background worker's startup path.
 */
import type {
  MessageActionToggle,
  MessageActionVisibility,
  MessageToolbarSettings,
} from '@/types';

/** Shipped defaults: every action visible on both roles, matching the bubble. */
export const DEFAULT_MESSAGE_TOOLBAR: MessageToolbarSettings = {
  copy: 'all',
  regenerate: 'show',
  delete: 'all',
  usage: 'show',
  time: 'all',
};

const VISIBILITIES: readonly MessageActionVisibility[] = [
  'all',
  'assistant',
  'user',
  'hidden',
];

const TOGGLES: readonly MessageActionToggle[] = ['show', 'hidden'];

function pickVisibility(
  raw: unknown,
  fallback: MessageActionVisibility,
): MessageActionVisibility {
  return VISIBILITIES.includes(raw as MessageActionVisibility)
    ? (raw as MessageActionVisibility)
    : fallback;
}

function pickToggle(raw: unknown, fallback: MessageActionToggle): MessageActionToggle {
  return TOGGLES.includes(raw as MessageActionToggle)
    ? (raw as MessageActionToggle)
    : fallback;
}

/**
 * Coerces a stored or imported record into a complete toolbar setting.
 *
 * Only an explicit, valid value is honoured; anything else — a predating
 * config, a hand-edited export, a partial fixture — lands on the shipped
 * default for that field. Applied on read *and* on import.
 */
export function normalizeMessageToolbar(raw: unknown): MessageToolbarSettings {
  const stored = (raw ?? {}) as Partial<Record<keyof MessageToolbarSettings, unknown>>;
  return {
    copy: pickVisibility(stored.copy, DEFAULT_MESSAGE_TOOLBAR.copy),
    regenerate: pickToggle(stored.regenerate, DEFAULT_MESSAGE_TOOLBAR.regenerate),
    delete: pickVisibility(stored.delete, DEFAULT_MESSAGE_TOOLBAR.delete),
    usage: pickToggle(stored.usage, DEFAULT_MESSAGE_TOOLBAR.usage),
    time: pickVisibility(stored.time, DEFAULT_MESSAGE_TOOLBAR.time),
  };
}

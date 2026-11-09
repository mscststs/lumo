/**
 * The three per-message display preferences the chat list and bubble need.
 *
 * They used to be loaded and watched separately inside `ChatMessageList`: one
 * `useState` + one `useEffect` + one storage-watch callback per field, with the
 * defaults restated on both paths. Adding a third switch made that duplication
 * obvious, so the read/watch/default policy lives here once.
 *
 * Returns primitives and a stable toolbar object, which keeps `MessageBubble`'s
 * `memo` shallow comparison effective.
 */
import { useEffect, useState } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import {
  DEFAULT_MESSAGE_TOOLBAR,
  normalizeMessageToolbar,
} from '@/lib/message-toolbar';
import type { MessageToolbarSettings, UISettings } from '@/types';

export interface MessageDisplaySettings {
  toolbar: MessageToolbarSettings;
  autoCollapseReasoning: boolean;
  /** Whether the TTFT metric is shown (live row + step ledger). */
  showTtft: boolean;
  /** Whether the output-speed metric is shown (live row + step ledger). */
  showThroughput: boolean;
}

const DEFAULTS: MessageDisplaySettings = {
  toolbar: DEFAULT_MESSAGE_TOOLBAR,
  autoCollapseReasoning: true,
  showTtft: true,
  showThroughput: true,
};

/**
 * Resolve a stored record.
 *
 * Exported for tests, and defensive on purpose: a partial record (an older
 * install, a hand-edited import, a test fixture) must land on the shipped
 * defaults rather than on `undefined`. The toolbar merge is per field because
 * an install written before `time` existed still carries the other four.
 */
export function resolveMessageDisplaySettings(
  stored:
    | Pick<
        UISettings,
        'messageToolbar' | 'autoCollapseReasoning' | 'ttftVisibility' | 'throughputVisibility'
      >
    | null
    | undefined,
): MessageDisplaySettings {
  return {
    toolbar: normalizeMessageToolbar(stored?.messageToolbar),
    autoCollapseReasoning: stored?.autoCollapseReasoning !== false,
    showTtft: stored?.ttftVisibility !== 'hidden',
    showThroughput: stored?.throughputVisibility !== 'hidden',
  };
}

export function useMessageDisplaySettings(): MessageDisplaySettings {
  const [settings, setSettings] = useState<MessageDisplaySettings>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    void storage
      .getUISettings()
      .then((stored) => {
        if (!cancelled) setSettings(resolveMessageDisplaySettings(stored));
      })
      .catch((error) => {
        // An unreadable settings blob leaves the shipped defaults in place.
        console.error('[Lumo] Failed to load message display settings:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useStorageWatch<UISettings>('uiSettings', (next) => {
    if (next) setSettings(resolveMessageDisplaySettings(next));
  });

  return settings;
}

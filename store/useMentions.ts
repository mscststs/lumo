import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_MENTION_SETTINGS,
  type MentionSettings,
} from '@/lib/mention-commands';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';

/**
 * Live view of mention settings.
 *
 * The options page writes; the composer reads. Both go through this hook so a
 * toggle flipped in one context is visible in the other without a reload.
 */
export function useMentionSettings(): {
  settings: MentionSettings;
  isLoaded: boolean;
  setSettings: (next: MentionSettings) => Promise<void>;
} {
  const [settings, setLocal] = useState<MentionSettings>(DEFAULT_MENTION_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void storage.getMentionSettings().then((loaded) => {
      if (cancelled) return;
      setLocal(loaded);
      setIsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useStorageWatch<MentionSettings>('mentionSettings', (next) => {
    if (!next) return;
    setLocal(next);
    setIsLoaded(true);
  });

  const setSettings = useCallback(async (next: MentionSettings) => {
    setLocal(next);
    await storage.setMentionSettings(next);
  }, []);

  return { settings, isLoaded, setSettings };
}

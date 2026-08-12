import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_COMMAND_SETTINGS,
  resolveEnabledCommands,
  type CommandSettings,
  type ResolvedCommand,
} from '@/lib/slash-commands';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';

/**
 * Live view of slash-command settings.
 *
 * The options page writes; the composer reads. Both go through this hook so a
 * toggle flipped in one context is visible in the other without a reload — the
 * same pattern as `uiSettings` for send-key and paste-threshold.
 */

export function useCommandSettings(): {
  settings: CommandSettings;
  /** True once the first storage read has landed. */
  isLoaded: boolean;
  setSettings: (next: CommandSettings) => Promise<void>;
} {
  const [settings, setLocal] = useState<CommandSettings>(DEFAULT_COMMAND_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void storage.getCommandSettings().then((loaded) => {
      if (cancelled) return;
      setLocal(loaded);
      setIsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useStorageWatch<CommandSettings>('commandSettings', (next) => {
    if (!next) return;
    setLocal(next);
    setIsLoaded(true);
  });

  const setSettings = useCallback(async (next: CommandSettings) => {
    // Optimistic local write so the options page's toggle feels instant; the
    // storage watch will re-confirm (or correct) once the write lands.
    setLocal(next);
    await storage.setCommandSettings(next);
  }, []);

  return { settings, isLoaded, setSettings };
}

/** Enabled commands only — what the composer and its picker actually use. */
export function useEnabledCommands(): ResolvedCommand[] {
  const { settings } = useCommandSettings();
  return useMemo(() => resolveEnabledCommands(settings), [settings]);
}

/**
 * The transcript scroll mode the chat list should use.
 *
 * Read through the same `uiSettings` record the options page writes, and
 * watched live so switching the mode in Personalization takes effect in an
 * already-open sidebar without a reload.
 */
import { useEffect, useState } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { DEFAULT_CHAT_SCROLL_MODE, normalizeChatScrollMode } from '@/lib/chat-scroll';
import type { ChatScrollMode, UISettings } from '@/types';

export function useChatScrollMode(): ChatScrollMode {
  const [mode, setMode] = useState<ChatScrollMode>(DEFAULT_CHAT_SCROLL_MODE);

  useEffect(() => {
    let cancelled = false;
    void storage
      .getUISettings()
      .then((stored) => {
        if (!cancelled) setMode(normalizeChatScrollMode(stored.chatScrollMode));
      })
      .catch((error) => {
        // An unreadable settings blob leaves the shipped default in place.
        console.error('[Lumo] Failed to load chat scroll mode:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useStorageWatch<UISettings>('uiSettings', (next) => {
    if (next) setMode(normalizeChatScrollMode(next.chatScrollMode));
  });

  return mode;
}

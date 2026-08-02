import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from './storage';
import { useStorageWatch } from './useStorageWatch';
import type { Conversation } from '@/types';

/**
 * Returns the chrome.storage.local key used to persist the current conversation
 * for a given panel. Panel 0 (rightmost / primary) uses the canonical
 * `currentConversationId` key for backward compatibility. Secondary panels
 * use `currentConversationId_1`, `currentConversationId_2`.
 */
function getCurrentConvStorageKey(panelId: number): string {
  return panelId === 0 ? 'currentConversationId' : `currentConversationId_${panelId}`;
}

interface UseConversationsOptions {
  /**
   * Panel identifier. 0 = rightmost (primary), 1 = second from right, etc.
   * Each panel persists its current conversation independently.
   */
  panelId?: number;
}

/**
 * Owns the conversation list and the currently open conversation.
 *
 * Storage is the source of truth for the list, so writes from another window's
 * side panel show up here immediately. `current` is deliberately *not* synced
 * from storage: another window switching conversations must not yank the
 * conversation out from under an in-flight stream in this one.
 */
export function useConversations(options?: UseConversationsOptions) {
  const panelId = options?.panelId ?? 0;
  const storageKey = getCurrentConvStorageKey(panelId);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  // Lets callbacks read the open conversation without depending on it, so the
  // identities returned below stay stable across renders.
  const currentRef = useRef<Conversation | null>(null);
  currentRef.current = current;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const list = await storage.getConversations();
      if (cancelled) return;
      setConversations(list);

      // Restore previously open conversation from this panel's storage key
      const result = await chrome.storage.local.get(storageKey);
      const currentId = result[storageKey] as string | null | undefined;
      if (cancelled) return;
      if (currentId) {
        setCurrent(list.find((c) => c.id === currentId) ?? null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useStorageWatch<Conversation[]>(
    'conversations',
    useCallback((newValue) => {
      setConversations(newValue ?? []);
    }, []),
  );

  /**
   * Writes a conversation through and keeps the local list in sync.
   *
   * `create` distinguishes the first write of a new conversation from later
   * updates: an update that finds nothing to replace was deleted meanwhile and
   * must not be resurrected.
   */
  const save = useCallback(async (conversation: Conversation, { create = false } = {}) => {
    setConversations(await storage.upsertConversation(conversation, { insertIfMissing: create }));
  }, []);

  /** Makes `conversation` the open one (pass `null` to start a fresh chat). */
  const open = useCallback(async (conversation: Conversation | null) => {
    setCurrent(conversation);
    await chrome.storage.local.set({ [storageKey]: conversation?.id ?? null });
  }, [storageKey]);

  /**
   * Deletes a conversation. Returns whether the open one was removed, so the
   * caller can abort a stream that no longer has anywhere to land.
   */
  const remove = useCallback(async (id: string) => {
    const remaining = (await storage.getConversations()).filter((c) => c.id !== id);
    await storage.setConversations(remaining);
    setConversations(remaining);

    if (currentRef.current?.id !== id) return false;

    setCurrent(null);
    await chrome.storage.local.set({ [storageKey]: null });
    return true;
  }, [storageKey]);

  const clearAll = useCallback(async () => {
    await storage.setConversations([]);
    await chrome.storage.local.set({ [storageKey]: null });
    setConversations([]);
    setCurrent(null);
  }, [storageKey]);

  return { conversations, current, save, open, remove, clearAll };
}

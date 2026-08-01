import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from './storage';
import { useStorageWatch } from './useStorageWatch';
import type { Conversation } from '@/types';

/**
 * Owns the conversation list and the currently open conversation.
 *
 * Storage is the source of truth for the list, so writes from another window's
 * side panel show up here immediately. `current` is deliberately *not* synced
 * from storage: another window switching conversations must not yank the
 * conversation out from under an in-flight stream in this one.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  // Lets callbacks read the open conversation without depending on it, so the
  // identities returned below stay stable across renders.
  const currentRef = useRef<Conversation | null>(null);
  currentRef.current = current;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [list, currentId] = await Promise.all([
        storage.getConversations(),
        storage.getCurrentConversationId(),
      ]);
      if (cancelled) return;

      setConversations(list);
      if (currentId) {
        setCurrent(list.find((c) => c.id === currentId) ?? null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
    await storage.setCurrentConversationId(conversation?.id ?? null);
  }, []);

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
    await storage.setCurrentConversationId(null);
    return true;
  }, []);

  const clearAll = useCallback(async () => {
    await storage.setConversations([]);
    await storage.setCurrentConversationId(null);
    setConversations([]);
    setCurrent(null);
  }, []);

  return { conversations, current, save, open, remove, clearAll };
}

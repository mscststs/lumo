import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from './storage';
import { useStorageWatch } from './useStorageWatch';
import { panelConversationKey } from '@/lib/panel-storage';
import {
  clearConversations,
  deleteConversation,
  getConversation,
  listConversationMeta,
  saveConversation as persistConversation,
  type ConversationMeta,
} from '@/lib/conversation-store';
import type { Conversation } from '@/types';

interface UseConversationsOptions {
  /**
   * Panel identifier. 0 = rightmost (primary), 1 = second from right, etc.
   * Each panel persists its current conversation independently.
   */
  panelId?: number;
  /**
   * Session IDs currently occupied by other panels. If the conversation this
   * panel would restore from storage is already occupied, it falls back to a
   * new chat instead of duplicating. This is checked at initialization time.
   */
  occupiedSessionIds?: string[];
}

/**
 * Owns the conversation list and the currently open conversation.
 *
 * The list is exposed as lightweight `ConversationMeta` summaries rather than
 * full conversations: the history UI only needs titles, timestamps and a
 * preview, and loading every message body to render it is what made the
 * previous single-key layout scale badly. The open conversation is read in full,
 * on demand.
 *
 * IndexedDB is the source of truth. Because it has no cross-context change
 * event, writes bump `conversationsRevision` in `chrome.storage` and every
 * context re-reads the summaries when it changes — so a write from another
 * window's side panel still shows up here immediately.
 *
 * `current` is deliberately *not* re-synced from that signal: another window
 * switching conversations must not yank the conversation out from under an
 * in-flight stream in this one.
 */
export function useConversations(options?: UseConversationsOptions) {
  const panelId = options?.panelId ?? 0;
  const storageKey = panelConversationKey(panelId);
  const occupiedSessionIds = options?.occupiedSessionIds;

  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  // Lets callbacks read the open conversation without depending on it, so the
  // identities returned below stay stable across renders.
  const currentRef = useRef<Conversation | null>(null);
  currentRef.current = current;

  // Use a ref to read occupiedSessionIds at init time without re-triggering the effect
  const occupiedRef = useRef(occupiedSessionIds);
  occupiedRef.current = occupiedSessionIds;

  const refreshList = useCallback(async () => {
    setConversations(await listConversationMeta());
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = await listConversationMeta();
        if (cancelled) return;
        setConversations(list);

        // Restore previously open conversation from this panel's storage key
        const result = await chrome.storage.local.get(storageKey);
        const currentId = result[storageKey] as string | null | undefined;
        if (cancelled || !currentId) return;

        // Check if this conversation is already occupied by another panel
        if (occupiedRef.current?.includes(currentId) ?? false) {
          // Fall back to new chat and clear storage to avoid stale conflicts
          setCurrent(null);
          await chrome.storage.local.set({ [storageKey]: null });
          return;
        }

        const restored = await getConversation(currentId);
        if (cancelled) return;
        setCurrent(restored);
      } catch (error) {
        // A failed restore must not leave the panel unusable: a blank chat is a
        // working fallback, and the list stays empty rather than half-applied.
        console.error('[Lumo] Failed to restore conversations:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  // IndexedDB has no `onChanged`; this counter is the cross-context signal.
  useStorageWatch<number>(
    'conversationsRevision',
    useCallback(() => {
      void refreshList().catch((error) => {
        console.error('[Lumo] Failed to refresh conversation list:', error);
      });
    }, [refreshList]),
  );

  /**
   * Writes a conversation through and keeps the local list in sync.
   *
   * `create` distinguishes the first write of a new conversation from later
   * updates: an update that finds nothing to replace was deleted meanwhile and
   * must not be resurrected.
   */
  const save = useCallback(async (conversation: Conversation, { create = false } = {}) => {
    const written = await persistConversation(conversation, { insertIfMissing: create });
    if (!written) return;
    await refreshList();
    await storage.bumpConversationsRevision();
  }, [refreshList]);

  /** Makes `conversation` the open one (pass `null` to start a fresh chat). */
  const open = useCallback(async (conversation: Conversation | null) => {
    setCurrent(conversation);
    await chrome.storage.local.set({ [storageKey]: conversation?.id ?? null });
  }, [storageKey]);

  /**
   * Opens a conversation by id, loading its messages.
   *
   * The history list carries summaries, so selecting an entry has to fetch the
   * full record before it can be shown.
   */
  const openById = useCallback(async (id: string) => {
    const conversation = await getConversation(id);
    if (!conversation) {
      // Deleted in another context between render and click.
      await refreshList();
      return null;
    }
    setCurrent(conversation);
    await chrome.storage.local.set({ [storageKey]: conversation.id });
    return conversation;
  }, [storageKey, refreshList]);

  /**
   * Deletes a conversation. Returns whether the open one was removed, so the
   * caller can abort a stream that no longer has anywhere to land.
   */
  const remove = useCallback(async (id: string) => {
    await deleteConversation(id);
    await refreshList();
    await storage.bumpConversationsRevision();

    if (currentRef.current?.id !== id) return false;

    setCurrent(null);
    await chrome.storage.local.set({ [storageKey]: null });
    return true;
  }, [storageKey, refreshList]);

  const clearAll = useCallback(async () => {
    await clearConversations();
    await chrome.storage.local.set({ [storageKey]: null });
    setConversations([]);
    setCurrent(null);
    await storage.bumpConversationsRevision();
  }, [storageKey]);

  return { conversations, current, save, open, openById, remove, clearAll };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from './storage';
import { useStorageWatch } from './useStorageWatch';
import { panelConversationKey, windowConversationKey, sessionPanelStorage } from '@/lib/panel-storage';
import { useWindowId } from '@/lib/window-id';
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
 * ## Window isolation
 *
 * The conversation pointer is stored in `chrome.storage.session` under a
 * window-scoped key (`w${windowId}_currentConversationId_${slot}`). This ensures:
 * - Different windows maintain independent conversation selections
 * - A new window always starts with a blank chat (no session key exists yet)
 * - Closing and reopening a side panel in the same session resumes the chat
 *
 * The local storage key is NOT written back for conversations (unlike model
 * selection), because resuming someone else's mid-stream conversation in a new
 * window would be confusing and error-prone.
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
 */
export function useConversations(options?: UseConversationsOptions) {
  const panelId = options?.panelId ?? 0;
  const windowId = useWindowId();
  const occupiedSessionIds = options?.occupiedSessionIds;

  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const currentRef = useRef<Conversation | null>(null);
  currentRef.current = current;

  const occupiedRef = useRef(occupiedSessionIds);
  occupiedRef.current = occupiedSessionIds;

  // Track the windowId in a ref for callbacks that shouldn't re-run on windowId change
  const windowIdRef = useRef(windowId);
  windowIdRef.current = windowId;

  const refreshList = useCallback(async () => {
    setConversations(await listConversationMeta());
  }, []);

  // Initialize: load conversation list and restore current conversation
  useEffect(() => {
    // Wait for windowId to be resolved before initializing
    if (windowId == null) return;

    let cancelled = false;

    void (async () => {
      try {
        const list = await listConversationMeta();
        if (cancelled) return;
        setConversations(list);

        // Try to restore from session storage (window-scoped)
        const sessionKey = windowConversationKey(windowId, panelId);
        const sessionResult = await chrome.storage.session.get(sessionKey);
        const currentId = sessionResult[sessionKey] as string | null | undefined;

        // If no session key exists, this is a new window — start blank
        if (cancelled || !currentId) return;

        // Check if this conversation is already occupied by another panel
        if (occupiedRef.current?.includes(currentId) ?? false) {
          setCurrent(null);
          await sessionPanelStorage.set({ [sessionKey]: null });
          return;
        }

        const restored = await getConversation(currentId);
        if (cancelled) return;
        setCurrent(restored);
      } catch (error) {
        console.error('[Lumo] Failed to restore conversations:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [windowId, panelId]);

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
   */
  const save = useCallback(async (conversation: Conversation, { create = false } = {}) => {
    const written = await persistConversation(conversation, { insertIfMissing: create });
    if (!written) return;
    await refreshList();
    await storage.bumpConversationsRevision();
  }, [refreshList]);

  /**
   * Writes a mid-stream snapshot — durability only, no observable side effects.
   */
  const saveDraft = useCallback(async (conversation: Conversation) => {
    await persistConversation(conversation, { insertIfMissing: false });
  }, []);

  /** Makes `conversation` the open one (pass `null` to start a fresh chat). */
  const open = useCallback(async (conversation: Conversation | null) => {
    setCurrent(conversation);
    const wId = windowIdRef.current;
    if (wId != null) {
      const sessionKey = windowConversationKey(wId, panelId);
      await sessionPanelStorage.set({ [sessionKey]: conversation?.id ?? null });
    }
  }, [panelId]);

  /**
   * Opens a conversation by id, loading its messages.
   */
  const openById = useCallback(async (id: string) => {
    const conversation = await getConversation(id);
    if (!conversation) {
      await refreshList();
      return null;
    }
    setCurrent(conversation);
    const wId = windowIdRef.current;
    if (wId != null) {
      const sessionKey = windowConversationKey(wId, panelId);
      await sessionPanelStorage.set({ [sessionKey]: conversation.id });
    }
    return conversation;
  }, [panelId, refreshList]);

  /**
   * Deletes a conversation. Returns whether the open one was removed.
   */
  const remove = useCallback(async (id: string) => {
    await deleteConversation(id);
    await refreshList();
    await storage.bumpConversationsRevision();

    if (currentRef.current?.id !== id) return false;

    setCurrent(null);
    const wId = windowIdRef.current;
    if (wId != null) {
      const sessionKey = windowConversationKey(wId, panelId);
      await sessionPanelStorage.set({ [sessionKey]: null });
    }
    return true;
  }, [panelId, refreshList]);

  const clearAll = useCallback(async () => {
    await clearConversations();
    const wId = windowIdRef.current;
    if (wId != null) {
      const sessionKey = windowConversationKey(wId, panelId);
      await sessionPanelStorage.set({ [sessionKey]: null });
    }
    setConversations([]);
    setCurrent(null);
    await storage.bumpConversationsRevision();
  }, [panelId]);

  return { conversations, current, save, saveDraft, open, openById, remove, clearAll };
}

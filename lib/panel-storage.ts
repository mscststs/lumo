/**
 * Per-panel storage layout: the keys each panel's state lives under.
 *
 * Each panel keeps its own conversation pointer and model choice, keyed by its
 * *slot*. Slot 0 uses the unsuffixed keys so conversations created before split
 * view existed keep working; other slots get a `_${slot}` suffix.
 *
 * A slot is assigned when a panel opens and never changes while it is mounted.
 * That is deliberate and load-bearing: `useConversations` keys its restore effect
 * off the conversation key, so changing a mounted panel's slot would re-read the
 * conversation from disk and clobber an in-flight stream. Screen position is
 * therefore tracked separately, as an order of slots — see `panel-order.ts`.
 *
 * Consequently there are no slot migrations here. An earlier version shifted
 * every higher slot's data down when a panel closed, to keep slot ids
 * contiguous; that forced the shifted panels to remount and aborted their
 * streams. Slots are now allowed to be sparse (`{0, 2}` is fine), so closing a
 * panel touches only its own keys.
 *
 * ## Window isolation
 *
 * Runtime per-panel state (current conversation, model selection) is scoped per
 * window via a `w${windowId}_` prefix and stored in `chrome.storage.session`.
 * This prevents one window's side panel from clobbering another's selections.
 *
 * The `local` keys (unsuffixed) remain as the **global default**: whenever a
 * panel changes its model, it also writes back to local so the next new window
 * inherits the most recent choice. Conversation pointers are NOT written back —
 * a new window always starts with a blank chat.
 */

import { MAX_SLOT_ID } from '@/lib/panel-order';

/** Minimal slice of a chrome.storage area these helpers need. */
export interface PanelStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

// ─── Key generation ─────────────────────────────────────────────────────────

/** Storage key holding the conversation a panel currently has open (global/default). */
export function panelConversationKey(slot: number): string {
  return slot === 0 ? 'currentConversationId' : `currentConversationId_${slot}`;
}

/** Storage key holding a panel's selected provider/model pair (global/default). */
export function panelModelKey(slot: number): string {
  return slot === 0 ? 'selectedModel' : `selectedModel_${slot}`;
}

/**
 * Window-scoped conversation key for session storage.
 * Format: `w${windowId}_currentConversationId` or `w${windowId}_currentConversationId_${slot}`
 */
export function windowConversationKey(windowId: number, slot: number): string {
  return `w${windowId}_${panelConversationKey(slot)}`;
}

/**
 * Window-scoped model selection key for session storage.
 * Format: `w${windowId}_selectedModel` or `w${windowId}_selectedModel_${slot}`
 */
export function windowModelKey(windowId: number, slot: number): string {
  return `w${windowId}_${panelModelKey(slot)}`;
}

/**
 * Window-scoped splitViewVisible key for session storage.
 */
export function windowVisibleLayoutKey(windowId: number): string {
  return `w${windowId}_splitViewVisible`;
}

// ─── Storage area accessors ─────────────────────────────────────────────────

/**
 * `chrome.storage.local`, narrowed to the surface these helpers use.
 *
 * The helpers take the area as a parameter so tests can pass a fake; this is the
 * one real implementation, shared so each caller does not re-wrap the three
 * methods itself.
 */
export const localPanelStorage: PanelStorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

/**
 * `chrome.storage.session`, for window-scoped runtime state.
 */
export const sessionPanelStorage: PanelStorageArea = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
};

// ─── Panel lifecycle ────────────────────────────────────────────────────────

/**
 * Opens a panel in `slot` on a blank conversation.
 *
 * The slot's model choice is deliberately left untouched, so re-opening a panel
 * restores the model it last used instead of snapping back to the first
 * configured provider.
 */
export async function openPanelSlot(
  storageArea: PanelStorageArea,
  slot: number,
  windowId?: number,
): Promise<void> {
  if (windowId != null) {
    await sessionPanelStorage.set({ [windowConversationKey(windowId, slot)]: null });
  } else {
    await storageArea.set({ [panelConversationKey(slot)]: null });
  }
}

/**
 * Releases a closed panel's slot.
 *
 * Only the conversation is given up, so another panel may claim it; the model
 * choice is preserved to match `openPanelSlot`. No other slot is read or
 * written — sibling panels keep their storage, stay mounted, and keep streaming.
 */
export async function releasePanelSlot(
  storageArea: PanelStorageArea,
  slot: number,
  windowId?: number,
): Promise<void> {
  if (windowId != null) {
    await sessionPanelStorage.remove(windowConversationKey(windowId, slot));
  } else {
    await storageArea.remove(panelConversationKey(slot));
  }
}

/**
 * Points every occupied slot at a blank conversation.
 *
 * Called after the conversation database is wiped from the options page: the
 * pointers left behind would otherwise name conversations that no longer exist,
 * and the next panel to restore one would come up on a conversation the user
 * just deleted.
 *
 * Resets both the session-scoped keys (all windows) and the local defaults.
 *
 * @returns The local keys that were reset, for logging/tests.
 */
export async function resetPanelConversations(
  storageArea: PanelStorageArea,
): Promise<string[]> {
  const keys = Array.from({ length: MAX_SLOT_ID + 1 }, (_, slot) =>
    panelConversationKey(slot),
  );
  const stored = await storageArea.get(keys);
  const occupied = keys.filter((key) => key in stored);

  if (occupied.length > 0) {
    await storageArea.set(Object.fromEntries(occupied.map((key) => [key, null])));
  }

  // Also clear any session-scoped conversation keys across all windows.
  // Session storage keys are prefixed `w${id}_`, so we fetch all and filter.
  try {
    const allSession = await chrome.storage.session.get(null);
    const sessionConvKeys = Object.keys(allSession).filter((k) =>
      /^w\d+_currentConversationId/.test(k),
    );
    if (sessionConvKeys.length > 0) {
      await chrome.storage.session.remove(sessionConvKeys);
    }
  } catch {
    // Session storage may not be available in all contexts (e.g. tests).
  }

  return occupied;
}

/**
 * A persisted provider/model pair, as stored under `panelModelKey`.
 */
interface PanelModelSelection {
  providerId: string;
  modelId: string;
}

/**
 * Drops every panel's model selection that no longer resolves against
 * `providers`, so deleting a provider or model in the options page cannot leave
 * a sidebar panel pointing at something that is gone.
 *
 * Walks every allocatable slot rather than the open panels: a closed panel keeps
 * its model choice on disk (see `releasePanelSlot`), and that stale choice must
 * not resurrect a deleted model when the slot is reused.
 *
 * Clearing the key (rather than writing a replacement) is deliberate:
 * `useModelSelection.loadData` already falls back to the first configured
 * model when the key is absent, and it is the single place that policy should
 * live.
 *
 * Also clears stale selections from session storage across all windows.
 *
 * @param providers The provider list *after* the deletion.
 * @returns The panel keys that were cleared, for logging/tests.
 */
export async function pruneStaleModelSelections(
  storageArea: PanelStorageArea,
  providers: { id: string; models: { id: string }[] }[],
): Promise<string[]> {
  const keys = Array.from({ length: MAX_SLOT_ID + 1 }, (_, slot) => panelModelKey(slot));
  const stored = await storageArea.get(keys);

  const stale = keys.filter((key) => {
    const selection = stored[key] as PanelModelSelection | null | undefined;
    if (!selection) return false;
    const provider = providers.find((p) => p.id === selection.providerId);
    return !provider?.models.some((m) => m.id === selection.modelId);
  });

  if (stale.length > 0) await storageArea.remove(stale);

  // Also prune session storage
  try {
    const allSession = await chrome.storage.session.get(null);
    const sessionModelKeys = Object.keys(allSession).filter((k) =>
      /^w\d+_selectedModel/.test(k),
    );
    const staleSession = sessionModelKeys.filter((key) => {
      const selection = allSession[key] as PanelModelSelection | null | undefined;
      if (!selection) return false;
      const provider = providers.find((p) => p.id === selection.providerId);
      return !provider?.models.some((m) => m.id === selection.modelId);
    });
    if (staleSession.length > 0) {
      await chrome.storage.session.remove(staleSession);
    }
  } catch {
    // Session storage may not be available in all contexts.
  }

  return stale;
}

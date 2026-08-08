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
 */

import { MAX_SLOT_ID } from '@/lib/panel-order';

/** Minimal slice of `chrome.storage.local` these helpers need. */
export interface PanelStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** Storage key holding the conversation a panel currently has open. */
export function panelConversationKey(slot: number): string {
  return slot === 0 ? 'currentConversationId' : `currentConversationId_${slot}`;
}

/** Storage key holding a panel's selected provider/model pair. */
export function panelModelKey(slot: number): string {
  return slot === 0 ? 'selectedModel' : `selectedModel_${slot}`;
}

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
): Promise<void> {
  await storageArea.set({ [panelConversationKey(slot)]: null });
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
): Promise<void> {
  await storageArea.remove(panelConversationKey(slot));
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
  return stale;
}

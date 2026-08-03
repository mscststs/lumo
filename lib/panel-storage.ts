/**
 * Per-panel storage layout and the slot migrations that split view performs.
 *
 * Each panel keeps its own conversation pointer and model choice. Panel 0 uses
 * the unsuffixed keys so conversations created before split view existed keep
 * working; secondary panels get a `_${panelId}` suffix.
 *
 * The migrations live here, apart from the component, so they can be tested
 * against a stub storage rather than re-implemented by a test.
 */

/** Minimal slice of `chrome.storage.local` these helpers need. */
export interface PanelStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** Storage key holding the conversation a panel currently has open. */
export function panelConversationKey(panelId: number): string {
  return panelId === 0 ? 'currentConversationId' : `currentConversationId_${panelId}`;
}

/** Storage key holding a panel's selected provider/model pair. */
export function panelModelKey(panelId: number): string {
  return panelId === 0 ? 'selectedModel' : `selectedModel_${panelId}`;
}

/**
 * Opens a new panel on a blank conversation.
 *
 * The slot's model choice is deliberately left untouched, so re-opening a panel
 * restores the model it last used instead of snapping back to the first
 * configured provider.
 */
export async function openPanelSlot(
  storageArea: PanelStorageArea,
  panelId: number,
): Promise<void> {
  await storageArea.set({ [panelConversationKey(panelId)]: null });
}

/**
 * Removes a panel, shifting every higher slot down by one so panel ids stay
 * contiguous.
 *
 * The vacated top slot only gives up its conversation — another panel may now
 * open it — while its model choice is preserved, matching `openPanelSlot`.
 *
 * @param closedPanelId The panel the user closed.
 * @param panelCount How many panels existed before the close.
 */
export async function closePanelSlot(
  storageArea: PanelStorageArea,
  closedPanelId: number,
  panelCount: number,
): Promise<void> {
  for (let id = closedPanelId; id < panelCount - 1; id++) {
    const sourceId = id + 1;
    const source = await storageArea.get([
      panelModelKey(sourceId),
      panelConversationKey(sourceId),
    ]);
    await storageArea.set({
      [panelModelKey(id)]: source[panelModelKey(sourceId)] ?? null,
      [panelConversationKey(id)]: source[panelConversationKey(sourceId)] ?? null,
    });
  }

  await storageArea.remove(panelConversationKey(panelCount - 1));
}

/**
 * Shifts an array of per-panel session ids to match `closePanelSlot`, clearing
 * the vacated top slot. Pure, so the component can feed it straight to setState.
 */
export function shiftPanelSessions(
  sessions: (string | null)[],
  closedPanelId: number,
  panelCount: number,
): (string | null)[] {
  const next = [...sessions];
  for (let id = closedPanelId; id < panelCount - 1; id++) {
    next[id] = next[id + 1] ?? null;
  }
  next[panelCount - 1] = null;
  return next;
}

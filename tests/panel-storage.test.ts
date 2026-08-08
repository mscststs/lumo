import { describe, it, expect, beforeEach } from 'vitest';
import {
  openPanelSlot,
  panelConversationKey,
  panelModelKey,
  pruneStaleModelSelections,
  releasePanelSlot,
  type PanelStorageArea,
} from '@/lib/panel-storage';

/** In-memory stand-in for `chrome.storage.local`. */
function createStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const area: PanelStorageArea = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
  return { area, store };
}

/** Mirrors `useModelSelection.loadData`'s resolution order. */
function resolveModel(
  store: Record<string, unknown>,
  panelId: number,
  providers: { id: string; models: { id: string }[] }[],
) {
  const saved = store[panelModelKey(panelId)] as
    | { providerId: string; modelId: string }
    | null
    | undefined;
  if (saved) return saved;
  const first = providers[0];
  if (first && first.models.length > 0) {
    return { providerId: first.id, modelId: first.models[0]!.id };
  }
  return null;
}

const providers = [
  { id: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
  { id: 'anthropic', models: [{ id: 'claude-opus' }] },
];

const GPT4O = { providerId: 'openai', modelId: 'gpt-4o' };
const MINI = { providerId: 'openai', modelId: 'gpt-4o-mini' };
const OPUS = { providerId: 'anthropic', modelId: 'claude-opus' };

describe('panel storage keys', () => {
  it('keeps slot 0 on the unsuffixed keys for backward compatibility', () => {
    expect(panelConversationKey(0)).toBe('currentConversationId');
    expect(panelModelKey(0)).toBe('selectedModel');
  });

  it('suffixes secondary slots', () => {
    expect(panelConversationKey(1)).toBe('currentConversationId_1');
    expect(panelModelKey(2)).toBe('selectedModel_2');
  });
});

describe('closing and re-opening a panel', () => {
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    storage = createStorage({
      selectedModel: GPT4O,
      currentConversationId: 'conv-0',
      selectedModel_1: OPUS,
      currentConversationId_1: 'conv-1',
    });
  });

  it('restores the panel model choice after close + re-split', async () => {
    await releasePanelSlot(storage.area, 1);

    // The conversation is released so another panel may claim it...
    expect(storage.store['currentConversationId_1']).toBeUndefined();
    // ...but the model choice must survive, or the reopened panel would
    // silently snap back to the first configured provider.
    expect(storage.store['selectedModel_1']).toEqual(OPUS);

    await openPanelSlot(storage.area, 1);

    expect(resolveModel(storage.store, 1, providers)).toEqual(OPUS);
    expect(storage.store['currentConversationId_1']).toBeNull();
  });

  it('leaves slot 0 untouched when closing slot 1', async () => {
    await releasePanelSlot(storage.area, 1);

    expect(storage.store['selectedModel']).toEqual(GPT4O);
    expect(storage.store['currentConversationId']).toBe('conv-0');
  });

  it('falls back to the first provider for a slot that was never used', () => {
    const empty = createStorage({ selectedModel: OPUS });
    expect(resolveModel(empty.store, 1, providers)).toEqual(GPT4O);
  });
});

describe('closing a middle panel leaves every sibling alone', () => {
  it('does not move any other slot, so no sibling remounts', async () => {
    // This is the regression that motivated slot/position separation. The old
    // `closePanelSlot` shifted slot 2's data down into slot 1 to keep ids
    // contiguous, which forced that panel to remount and aborted its stream.
    // Slots are now sparse, so closing the middle panel is purely local.
    const storage = createStorage({
      selectedModel: GPT4O,
      currentConversationId: 'conv-0',
      selectedModel_1: OPUS,
      currentConversationId_1: 'conv-1',
      selectedModel_2: MINI,
      currentConversationId_2: 'conv-2',
    });

    await releasePanelSlot(storage.area, 1);

    // Slot 2 keeps both its conversation and its model: it is still open, and
    // may still be mid-stream.
    expect(storage.store['selectedModel_2']).toEqual(MINI);
    expect(storage.store['currentConversationId_2']).toBe('conv-2');
    // The closed slot gives up its conversation but keeps its model.
    expect(storage.store['currentConversationId_1']).toBeUndefined();
    expect(storage.store['selectedModel_1']).toEqual(OPUS);
    // Slot 0 is never involved.
    expect(storage.store['selectedModel']).toEqual(GPT4O);
    expect(storage.store['currentConversationId']).toBe('conv-0');
  });

  it('tolerates closing a slot that holds nothing', async () => {
    const storage = createStorage({ selectedModel_1: OPUS });

    await releasePanelSlot(storage.area, 2);

    expect(storage.store['selectedModel_1']).toEqual(OPUS);
  });
});

describe('pruneStaleModelSelections', () => {
  it('clears a selection whose provider was deleted', async () => {
    const storage = createStorage({ selectedModel: OPUS, selectedModel_1: GPT4O });

    // `anthropic` is gone from the config.
    const cleared = await pruneStaleModelSelections(storage.area, [providers[0]!]);

    expect(cleared).toEqual(['selectedModel']);
    expect(storage.store['selectedModel']).toBeUndefined();
    expect(storage.store['selectedModel_1']).toEqual(GPT4O);
  });

  it('clears a selection whose model was deleted but provider remains', async () => {
    const storage = createStorage({ selectedModel: MINI });

    await pruneStaleModelSelections(storage.area, [
      { id: 'openai', models: [{ id: 'gpt-4o' }] },
      providers[1]!,
    ]);

    expect(storage.store['selectedModel']).toBeUndefined();
  });

  it('prunes closed slots too, since they keep their model on disk', async () => {
    // Slot 2 is not open, but `releasePanelSlot` preserved its choice — it must
    // not resurrect a deleted model when the slot is reused.
    const storage = createStorage({ selectedModel_2: OPUS });


    const cleared = await pruneStaleModelSelections(storage.area, [providers[0]!]);

    expect(cleared).toEqual(['selectedModel_2']);
  });

  it('leaves still-valid selections and absent keys alone', async () => {
    const storage = createStorage({ selectedModel: GPT4O });

    const cleared = await pruneStaleModelSelections(storage.area, providers);

    expect(cleared).toEqual([]);
    expect(storage.store['selectedModel']).toEqual(GPT4O);
  });

  it('clears everything when the last provider is removed', async () => {
    const storage = createStorage({ selectedModel: GPT4O, selectedModel_1: OPUS });

    await pruneStaleModelSelections(storage.area, []);

    expect(storage.store['selectedModel']).toBeUndefined();
    expect(storage.store['selectedModel_1']).toBeUndefined();
  });
});

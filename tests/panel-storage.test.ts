import { describe, it, expect, beforeEach } from 'vitest';
import {
  closePanelSlot,
  openPanelSlot,
  panelConversationKey,
  panelModelKey,
  shiftPanelSessions,
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
  it('keeps panel 0 on the unsuffixed keys for backward compatibility', () => {
    expect(panelConversationKey(0)).toBe('currentConversationId');
    expect(panelModelKey(0)).toBe('selectedModel');
  });

  it('suffixes secondary panels', () => {
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
    await closePanelSlot(storage.area, 1, 2);

    // The conversation is released so another panel may claim it...
    expect(storage.store['currentConversationId_1']).toBeUndefined();
    // ...but the model choice must survive, or the reopened panel would
    // silently snap back to the first configured provider.
    expect(storage.store['selectedModel_1']).toEqual(OPUS);

    await openPanelSlot(storage.area, 1);

    expect(resolveModel(storage.store, 1, providers)).toEqual(OPUS);
    expect(storage.store['currentConversationId_1']).toBeNull();
  });

  it('leaves panel 0 untouched when closing panel 1', async () => {
    await closePanelSlot(storage.area, 1, 2);

    expect(storage.store['selectedModel']).toEqual(GPT4O);
    expect(storage.store['currentConversationId']).toBe('conv-0');
  });

  it('falls back to the first provider for a slot that was never used', () => {
    const empty = createStorage({ selectedModel: OPUS });
    expect(resolveModel(empty.store, 1, providers)).toEqual(GPT4O);
  });
});

describe('closing a middle panel shifts higher slots down', () => {
  it('moves panel 2 into panel 1 and vacates the top slot', async () => {
    const storage = createStorage({
      selectedModel: GPT4O,
      currentConversationId: 'conv-0',
      selectedModel_1: OPUS,
      currentConversationId_1: 'conv-1',
      selectedModel_2: MINI,
      currentConversationId_2: 'conv-2',
    });

    await closePanelSlot(storage.area, 1, 3);

    // Panel 2's state slides down into slot 1.
    expect(storage.store['selectedModel_1']).toEqual(MINI);
    expect(storage.store['currentConversationId_1']).toBe('conv-2');
    // The vacated top slot gives up its conversation but keeps its model.
    expect(storage.store['currentConversationId_2']).toBeUndefined();
    // Panel 0 is never involved.
    expect(storage.store['selectedModel']).toEqual(GPT4O);
    expect(storage.store['currentConversationId']).toBe('conv-0');
  });

  it('treats a missing source slot as empty rather than throwing', async () => {
    const storage = createStorage({ selectedModel_1: OPUS });

    await closePanelSlot(storage.area, 1, 3);

    expect(storage.store['selectedModel_1']).toBeNull();
    expect(storage.store['currentConversationId_1']).toBeNull();
  });
});

describe('shiftPanelSessions', () => {
  it('shifts claims down and clears the vacated slot', () => {
    expect(shiftPanelSessions(['a', 'b', 'c'], 1, 3)).toEqual(['a', 'c', null]);
  });

  it('clears the top slot when it is the one closed', () => {
    expect(shiftPanelSessions(['a', 'b', null], 1, 2)).toEqual(['a', null, null]);
  });

  it('does not mutate its input', () => {
    const sessions = ['a', 'b', 'c'];
    shiftPanelSessions(sessions, 1, 3);
    expect(sessions).toEqual(['a', 'b', 'c']);
  });
});

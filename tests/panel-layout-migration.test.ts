// @vitest-environment jsdom
/**
 * Upgrading an existing install must not appear to forget the user's split view.
 *
 * Split view used to store a panel *count*, deriving each panel's position from
 * its slot id as `count-1-i`. Now that panels can be reordered, position is
 * stored outright. The migration has to reproduce exactly the arrangement the old
 * code rendered, or a user with two panels open reopens the sidebar to one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateLegacyPanelCount } from '@/store/storage';

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
});

describe('migrateLegacyPanelCount', () => {
  it('turns a two-panel count into the order the old code rendered', () => {
    // The old mapping put slot 0 rightmost, so a count of 2 means [1, 0].
    store['splitView_intendedPanelCount'] = 2;
    return migrateLegacyPanelCount().then(() => {
      expect(store['splitViewLayout']).toEqual({ order: [1, 0] });
    });
  });

  it('handles three panels', async () => {
    store['splitView_intendedPanelCount'] = 3;
    await migrateLegacyPanelCount();
    expect(store['splitViewLayout']).toEqual({ order: [2, 1, 0] });
  });

  it('removes the legacy keys so nothing can revive a stale layout', async () => {
    store['splitView_intendedPanelCount'] = 2;
    store['splitView_visiblePanelCount'] = 2;
    await migrateLegacyPanelCount();
    expect(store['splitView_intendedPanelCount']).toBeUndefined();
    expect(store['splitView_visiblePanelCount']).toBeUndefined();
  });

  it('does not overwrite a layout that already exists', async () => {
    // A downgrade followed by an upgrade would otherwise replace a real order
    // with a count written by the older build.
    store['splitViewLayout'] = { order: [0, 2, 1] };
    store['splitView_intendedPanelCount'] = 2;
    await migrateLegacyPanelCount();
    expect(store['splitViewLayout']).toEqual({ order: [0, 2, 1] });
  });

  it('writes nothing for a fresh install', async () => {
    await migrateLegacyPanelCount();
    expect(store['splitViewLayout']).toBeUndefined();
  });

  it('ignores a malformed count rather than writing a broken layout', async () => {
    for (const bad of ['2', 0, -1, 1.5, null, {}]) {
      store = { splitView_intendedPanelCount: bad };
      await migrateLegacyPanelCount();
      expect(store['splitViewLayout']).toBeUndefined();
    }
  });

  it('clamps a count beyond the allocatable slots', async () => {
    store['splitView_intendedPanelCount'] = 9;
    await migrateLegacyPanelCount();
    expect(store['splitViewLayout']).toEqual({ order: [2, 1, 0] });
  });

  it('is idempotent, so running it on every startup is safe', async () => {
    store['splitView_intendedPanelCount'] = 2;
    await migrateLegacyPanelCount();
    const first = store['splitViewLayout'];
    await migrateLegacyPanelCount();
    expect(store['splitViewLayout']).toEqual(first);
  });

  it('leaves a single-panel install on the legacy storage keys', async () => {
    // Slot 0 uses the unsuffixed keys, so the commonest install migrates to an
    // order that changes nothing about where its conversation lives.
    store['splitView_intendedPanelCount'] = 1;
    await migrateLegacyPanelCount();
    expect(store['splitViewLayout']).toEqual({ order: [0] });
  });
});

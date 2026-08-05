import { describe, it, expect } from 'vitest';
import {
  isSameOrder,
  moveItem,
  moveModelById,
  reconcileOrder,
} from '@/entrypoints/options/models/reorder';
import type { ModelConfig } from '@/types';

function m(id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { id, modelId: id, displayName: id.toUpperCase(), isVision: false, ...overrides };
}

const ids = (models: ModelConfig[]) => models.map((x) => x.id);

describe('moveItem', () => {
  it('moves an item forward and back', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns the input unchanged for a no-op or out-of-range move', () => {
    const items = ['a', 'b', 'c'];
    // Same index, past either end, or a bogus source: all must not clamp, so a
    // disabled "move up" at the top cannot silently reorder anything.
    for (const [from, to] of [
      [1, 1],
      [0, -1],
      [2, 3],
      [-1, 0],
      [9, 0],
    ] as const) {
      expect(moveItem(items, from, to)).toBe(items);
    }
  });

  it('does not mutate its input', () => {
    const items = ['a', 'b', 'c'];
    moveItem(items, 0, 2);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('moveModelById', () => {
  const models = [m('a'), m('b'), m('c')];

  it('shifts a model up and down by one slot', () => {
    expect(ids(moveModelById(models, 'c', -1))).toEqual(['a', 'c', 'b']);
    expect(ids(moveModelById(models, 'a', 1))).toEqual(['b', 'a', 'c']);
  });

  it('refuses to move past either end', () => {
    expect(moveModelById(models, 'a', -1)).toBe(models);
    expect(moveModelById(models, 'c', 1)).toBe(models);
  });

  it('ignores an unknown id', () => {
    expect(moveModelById(models, 'nope', 1)).toBe(models);
  });
});

describe('isSameOrder', () => {
  it('compares by id and position, not by object identity', () => {
    expect(isSameOrder([m('a'), m('b')], [m('a'), m('b')])).toBe(true);
    expect(isSameOrder([m('a'), m('b')], [m('b'), m('a')])).toBe(false);
    expect(isSameOrder([m('a')], [m('a'), m('b')])).toBe(false);
  });

  it('treats a renamed model at the same position as the same order', () => {
    // Only ordering matters here — this gate exists to skip redundant storage
    // writes, and a rename is committed through a different path.
    expect(isSameOrder([m('a', { displayName: 'Old' })], [m('a', { displayName: 'New' })])).toBe(
      true,
    );
  });
});

/**
 * `reconcileOrder` guards the drag-vs-storage race: `Reorder` hands back the
 * array that was *rendered*, so anything another context changed mid-drag would
 * be reverted by the drop without this step.
 */
describe('reconcileOrder', () => {
  it('keeps the dragged order', () => {
    const dragged = [m('c'), m('a'), m('b')];
    const authority = [m('a'), m('b'), m('c')];
    expect(ids(reconcileOrder(dragged, authority))).toEqual(['c', 'a', 'b']);
  });

  it('takes contents from the authority so a concurrent rename survives', () => {
    const dragged = [m('b', { displayName: 'Stale' }), m('a')];
    const authority = [m('a'), m('b', { displayName: 'Renamed elsewhere' })];

    const result = reconcileOrder(dragged, authority);

    expect(ids(result)).toEqual(['b', 'a']);
    expect(result[0]!.displayName).toBe('Renamed elsewhere');
  });

  it('drops a model deleted mid-drag', () => {
    const dragged = [m('c'), m('a'), m('b')];
    const authority = [m('a'), m('c')];
    expect(ids(reconcileOrder(dragged, authority))).toEqual(['c', 'a']);
  });

  it('appends a model added mid-drag rather than losing it', () => {
    const dragged = [m('b'), m('a')];
    const authority = [m('a'), m('b'), m('new')];
    expect(ids(reconcileOrder(dragged, authority))).toEqual(['b', 'a', 'new']);
  });

  it('is a no-op when nothing moved', () => {
    const authority = [m('a'), m('b')];
    expect(ids(reconcileOrder([m('a'), m('b')], authority))).toEqual(['a', 'b']);
  });
});

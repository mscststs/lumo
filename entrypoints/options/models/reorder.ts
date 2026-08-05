import type { ModelConfig } from '@/types';

/**
 * Pure list-reordering helpers for the models list.
 *
 * Kept out of the components so the ordering rules can be tested without a DOM
 * or a drag simulation. `Reorder` from `motion` hands back a whole reordered
 * array, while the keyboard path moves a single item — both funnel through here
 * so the two input methods cannot drift apart.
 */

/**
 * Moves the model at `from` to index `to`.
 *
 * Out-of-range targets return the input unchanged rather than clamping: the
 * caller is a "move up"/"move down" affordance that should be *disabled* at the
 * ends, and silently clamping would make a keypress at the boundary look like it
 * worked while nothing moved.
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items;
  if (to < 0 || to >= items.length || to === from) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Moves the model with `modelId` by `delta` slots. */
export function moveModelById(
  models: ModelConfig[],
  modelId: string,
  delta: number,
): ModelConfig[] {
  const from = models.findIndex((m) => m.id === modelId);
  if (from < 0) return models;
  return moveItem(models, from, from + delta);
}

/**
 * Whether two lists hold the same models in the same order.
 *
 * Used to skip a storage write when a drag ends where it started — dropping an
 * item back in place should not churn `chrome.storage` or bump the resume
 * fingerprint for every open panel.
 */
export function isSameOrder(a: ModelConfig[], b: ModelConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((model, index) => model.id === b[index]?.id);
}

/**
 * Reconciles a reordered list against the authoritative one.
 *
 * `Reorder` operates on the array it was rendered with, which may be a frame
 * behind storage if another context edited the same provider mid-drag. This
 * keeps the dragged *order* but re-reads each model's contents from `authority`,
 * and drops ids that no longer exist, so a concurrent rename or delete is not
 * reverted by the drop.
 */
export function reconcileOrder(
  dragged: ModelConfig[],
  authority: ModelConfig[],
): ModelConfig[] {
  const byId = new Map(authority.map((m) => [m.id, m]));
  const ordered = dragged
    .map((m) => byId.get(m.id))
    .filter((m): m is ModelConfig => m !== undefined);
  // Anything added elsewhere while the drag was in flight is appended rather
  // than dropped.
  const seen = new Set(ordered.map((m) => m.id));
  return [...ordered, ...authority.filter((m) => !seen.has(m.id))];
}

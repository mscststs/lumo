/**
 * @vitest-environment jsdom
 *
 * Behavioural cover for the reorderable model list.
 *
 * The risk this guards is interaction overlap: the row is a button that opens
 * the edit dialog, and it now also lives inside a drag-and-drop list. If the
 * drag were bound to the row instead of to a dedicated handle, clicking a model
 * would be ambiguous with starting a drag. These tests assert the two gestures
 * stay separate, and that keyboard users can reorder at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Reorder } from 'motion/react';
import { ModelRow } from '@/entrypoints/options/models/ModelRow';
import type { ModelConfig } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo the key so assertions can target it without duplicating copy.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.name ? `${key}:${vars.name}` : key,
  }),
}));

afterEach(cleanup);

const MODELS: ModelConfig[] = [
  { id: 'a', modelId: 'gpt-4o', displayName: 'GPT-4o', isVision: true },
  { id: 'b', modelId: 'gpt-4o-mini', displayName: 'Mini', isVision: false },
  { id: 'c', modelId: 'o3', displayName: 'O3', isVision: false },
];

interface RowHandlers {
  onEdit?: () => void;
  onDelete?: () => void;
  onMove?: (delta: number) => void;
  onDragEnd?: () => void;
}

function renderRow(index: number, handlers: RowHandlers = {}) {
  const onEdit = vi.fn(handlers.onEdit);
  const onMove = vi.fn(handlers.onMove);
  const onDelete = vi.fn(handlers.onDelete);
  const onDragEnd = vi.fn(handlers.onDragEnd);

  render(
    <Reorder.Group axis="y" values={MODELS} onReorder={() => {}}>
      <ModelRow
        model={MODELS[index]!}
        index={index}
        total={MODELS.length}
        onEdit={onEdit}
        onDelete={onDelete}
        onMove={onMove}
        onDragEnd={onDragEnd}
      />
    </Reorder.Group>,
  );

  const handle = screen.getByRole('button', {
    name: /options\.models\.dragToReorder/,
  });
  return { onEdit, onMove, onDelete, onDragEnd, handle };
}

describe('ModelRow reordering', () => {
  it('exposes a drag handle separate from the row', () => {
    const { handle, onEdit } = renderRow(0);

    expect(handle).toBeTruthy();
    // Touching the handle must not open the editor.
    fireEvent.pointerDown(handle);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('still opens the editor when the row body is clicked', () => {
    const { onEdit } = renderRow(0);

    fireEvent.click(screen.getByText('GPT-4o'));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('announces the position for screen readers', () => {
    const { handle } = renderRow(1);
    // "…— Mini (2/3)": position is not conveyed visually, so it has to be in
    // the accessible name.
    expect(handle.getAttribute('aria-label')).toContain('Mini (2/3)');
  });

  it('reorders with the arrow keys', () => {
    const { onMove, handle } = renderRow(1);

    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onMove).toHaveBeenCalledWith(-1);

    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onMove).toHaveBeenCalledWith(1);
  });

  it('does not move past either end of the list', () => {
    const first = renderRow(0);
    fireEvent.keyDown(first.handle, { key: 'ArrowUp' });
    expect(first.onMove).not.toHaveBeenCalled();
    cleanup();

    const last = renderRow(2);
    fireEvent.keyDown(last.handle, { key: 'ArrowDown' });
    expect(last.onMove).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys on the handle', () => {
    const { onMove, handle } = renderRow(1);

    for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'Tab']) {
      fireEvent.keyDown(handle, { key });
    }

    expect(onMove).not.toHaveBeenCalled();
  });

  it('keeps the delete action reachable and confirmed', () => {
    const { onDelete } = renderRow(0);

    fireEvent.click(screen.getByRole('button', { name: /common\.delete GPT-4o/ }));

    // Deleting is two-step; the first click only reveals the confirmation.
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('opts the handle out of native touch scrolling', () => {
    const { handle } = renderRow(0);
    // Without `touch-none` the browser claims the gesture for scrolling and the
    // drag never starts on a touch device.
    expect(handle.className).toContain('touch-none');
  });
});

/**
 * The drag "lift" (shadow) must be driven by a CSS class, never by `whileDrag`.
 *
 * `whileDrag` animates values back to `baseTarget`, which motion seeds only from
 * `style`/`initial`. A `boxShadow` declared in `className` is invisible to that,
 * so `getBaseTarget('boxShadow')` returns undefined and the inline shadow motion
 * wrote during the drag is never removed — leaving a permanent shadow on any row
 * that was picked up, even when dropped without reordering.
 */
describe('ModelRow drag affordance', () => {
  const SOURCE = readFileSync(
    resolve(__dirname, '../entrypoints/options/models/ModelRow.tsx'),
    'utf8',
  );
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('does not use whileDrag for un-revertable properties', () => {
    expect(CODE).not.toContain('whileDrag');
  });

  it('does not fight the primitive over zIndex', () => {
    // `Reorder.Item` already drives zIndex internally (1 while offset, `unset`
    // at rest), so setting it here would conflict.
    expect(CODE).not.toContain('zIndex');
  });

  it('starts with no shadow so an untouched row is flat', () => {
    renderRow(0);
    const item = screen.getByText('GPT-4o').closest('li')!;

    expect(item.className).toContain('shadow-none');
    expect(item.className).not.toContain('shadow-lg');
    // Crucially, nothing inline — that is what used to linger after a drag.
    expect(item.style.boxShadow).toBe('');
  });

  it('applies the lift through a class toggled by drag state', () => {
    // Asserts the mechanism: a `dragging` flag selecting between two class sets,
    // which React removes on drag end regardless of motion's value plumbing.
    expect(CODE).toMatch(/setDragging\(true\)/);
    expect(CODE).toMatch(/setDragging\(false\)/);
    expect(CODE).toMatch(/dragging\s*\?/);
    expect(CODE).toContain('shadow-lg');
    expect(CODE).toContain('shadow-none');
  });

  it('still commits the order when a drag ends', () => {
    // The drag-end handler now also clears local state; the commit must survive.
    expect(CODE).toMatch(/onDragEnd\(\)/);
  });
});

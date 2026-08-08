// @vitest-environment jsdom
/**
 * The panel header is the only drag surface for reordering.
 *
 * There is no dedicated grip, so the header itself has to distinguish "drag the
 * panel" from "press the thing under the pointer". Getting that hit-test wrong is
 * a silent regression in both directions: a too-greedy surface swallows clicks on
 * the model picker, and a too-timid one leaves no way to reorder at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChatHeader } from '@/components/chat/ChatHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: { get: async () => ({}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
});

const base = {
  currentModelValue: 'p::m',
  allModels: [{ value: 'p::m', label: 'M' }],
  providers: [{ id: 'p', name: 'P', models: [{ id: 'm', displayName: 'M' }] }] as never,
  onModelChange: vi.fn(),
  onNewChat: vi.fn(),
  onOpenHistory: vi.fn(),
};

describe('header drag surface', () => {
  it('shows no separate drag handle', () => {
    const { container } = render(<ChatHeader {...base} onReorderPointerDown={vi.fn()} />);
    expect(container.querySelector('[data-drag-handle]')).toBeNull();
  });

  it('starts a drag from empty header space', () => {
    const onReorderPointerDown = vi.fn();
    const { container } = render(
      <ChatHeader {...base} onReorderPointerDown={onReorderPointerDown} />,
    );

    container
      .querySelector('header')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));

    expect(onReorderPointerDown).toHaveBeenCalledTimes(1);
  });

  it('leaves buttons clickable', () => {
    // The close button sits at the end of the header. A drag starting here would
    // make the button unusable, since the gesture suppresses the click.
    const onReorderPointerDown = vi.fn();
    const { container } = render(
      <ChatHeader {...base} onReorderPointerDown={onReorderPointerDown} onClose={vi.fn()} />,
    );

    const buttons = container.querySelectorAll('button');
    buttons[buttons.length - 1]!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );

    expect(onReorderPointerDown).not.toHaveBeenCalled();
  });

  it('leaves the model picker operable', () => {
    const onReorderPointerDown = vi.fn();
    const { container } = render(
      <ChatHeader {...base} onReorderPointerDown={onReorderPointerDown} />,
    );

    container
      .querySelector('[role="combobox"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));

    expect(onReorderPointerDown).not.toHaveBeenCalled();
  });

  it('does nothing when reordering is unavailable', () => {
    // A lone panel gets no handler at all, so the header must not claim the
    // gesture or suppress text selection.
    const { container } = render(<ChatHeader {...base} />);
    const header = container.querySelector('header')!;

    expect(header.className).not.toContain('touch-none');
    // No throw, and nothing to assert beyond that: there is no handler to call.
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  });
});

// @vitest-environment jsdom
/**
 * The toolbar shows exactly one tooltip at a time, and the pointer decides which.
 *
 * Regression: a single `TooltipProvider` for the whole row let Radix's
 * hoverable-content grace area leak across siblings. The grace area is what
 * keeps the tall token panel open while the pointer travels from the trigger
 * into the ledger, but while it is active the provider sets
 * `isPointerInTransitRef` and *every* trigger in that provider ignores pointer
 * movement. So hovering usage and then sliding to delete/time left the panel up
 * and swallowed the label: the user saw the token breakdown and no tooltip for
 * the control under the pointer.
 *
 * The panel now owns its provider (its grace area stays inside it) and the row
 * provider is `disableHoverableContent` (a one-line label has nothing to move
 * into, so it needs no grace area at all).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatMessage, MessageToolbarSettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');

afterEach(cleanup);

const TOOLBAR: MessageToolbarSettings = {
  copy: 'all',
  regenerate: 'show',
  delete: 'all',
  usage: 'show',
  time: 'all',
};

const ASSISTANT: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  timestamp: Date.now() - 5 * 60_000,
  parts: [{ type: 'text', text: 'hi' }],
  usage: { inputTokens: 1_200, outputTokens: 340, totalTokens: 1_540 },
};

const trigger = (label: string) => screen.getByRole('button', { name: label });

/** Delete and regenerate only render when the panel wires up the handlers. */
function renderBubble() {
  return render(
    <MessageBubble
      message={ASSISTANT}
      toolbar={TOOLBAR}
      isLastAssistant
      onDelete={vi.fn()}
      onRegenerate={vi.fn()}
    />,
  );
}

/**
 * What a browser actually does when the pointer crosses from `from` to `to`:
 * `pointerout` (React's `onPointerLeave`), `pointerleave` (the native listener
 * that records a hoverable tooltip's grace area), `pointerover`, `pointermove`.
 */
function movePointer(from: HTMLElement, to: HTMLElement) {
  fireEvent.pointerOut(from, { relatedTarget: to });
  fireEvent.pointerLeave(from);
  fireEvent.pointerOver(to, { relatedTarget: from });
  fireEvent.pointerMove(to);
}

/** Waits until the only visible tooltip is `expected` (open is delayed 300ms). */
async function expectSoleTooltip(expected: string) {
  await waitFor(() => {
    expect(screen.queryAllByRole('tooltip').map((tip) => tip.textContent)).toEqual([expected]);
  });
}

describe('message toolbar tooltips', () => {
  it('hands the hover from the token panel to delete', async () => {
    renderBubble();

    const usage = trigger('sidebar.tokenUsage');
    fireEvent.pointerMove(usage);
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('sidebar.tokenTotal');
    });

    movePointer(usage, trigger('sidebar.delete'));
    await expectSoleTooltip('sidebar.delete');
  });

  it('hands the hover from the token panel to the timestamp', async () => {
    const { container } = renderBubble();

    const usage = trigger('sidebar.tokenUsage');
    fireEvent.pointerMove(usage);
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('sidebar.tokenTotal');
    });

    const time = container.querySelector('time')!;
    movePointer(usage, time);
    // The timestamp's label is the full localised date, not its relative text.
    await expectSoleTooltip(time.getAttribute('aria-label')!);
  });

  it('keeps the token panel open while the pointer is inside it', async () => {
    renderBubble();

    const usage = trigger('sidebar.tokenUsage');
    fireEvent.pointerMove(usage);
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('sidebar.tokenTotal');
    });

    // Moving into the ledger must not dismiss the panel: this is why its grace
    // area (and therefore its own provider) has to stay.
    fireEvent.pointerOut(usage, { relatedTarget: screen.getByRole('tooltip') });
    fireEvent.pointerLeave(usage);
    fireEvent.pointerMove(screen.getByRole('tooltip'));
    await expectSoleTooltip(screen.getByRole('tooltip').textContent!);
    expect(screen.getByRole('tooltip').textContent).toContain('sidebar.tokenTotal');
  });

  it('still hands over instantly between two labels', async () => {
    renderBubble();

    fireEvent.pointerMove(trigger('sidebar.copy'));
    await expectSoleTooltip('sidebar.copy');

    movePointer(trigger('sidebar.copy'), trigger('sidebar.delete'));
    await expectSoleTooltip('sidebar.delete');
  });
});

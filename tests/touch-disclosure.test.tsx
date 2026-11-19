// @vitest-environment jsdom
/**
 * Touch devices must be able to open the information panels, not just see them.
 *
 * Radix's tooltip is hover-only by construction — its trigger ignores
 * `pointermove` from touch, suppresses the focus-open a tap causes, and closes
 * on the click that follows — so the token breakdown, the context gauge and the
 * exact message time were three visible buttons that did nothing on a phone or
 * a tablet. `Hint` routes those panels through a popover where hover does not
 * exist. These tests pin that second path: the tap opens the panel, the tap
 * toggles it, Escape and an outside tap dismiss it, hover does *not* open it,
 * and focus stays on the trigger instead of jumping into the panel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatMessage, MessageToolbarSettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { ContextUsageRing } = await import('@/components/chat/ContextUsageRing');

afterEach(cleanup);

/** Reports a coarse pointer: no hover, no fine pointer. */
function stubTouchPointer(): void {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

stubTouchPointer();

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

const trigger = (label: string) => screen.getByRole('button', { name: label });

describe('touch disclosure', () => {
  it('opens the token breakdown by tapping the icon', () => {
    renderBubble();

    // Nothing is rendered before the tap: on touch there is no hover to wait on.
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger('sidebar.tokenUsage'));

    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('sidebar.tokenTotal');
    // Same clamp contract as the hover path: one `max-h` class, two Radix
    // variables, resolved by `Hint`.
    expect(panel.className).toContain('max-h-[var(--hint-available-height)]');
    expect(panel.style.getPropertyValue('--hint-available-height')).toBe(
      'var(--radix-popover-content-available-height)',
    );
    // And the trigger admits it owns an open disclosure.
    expect(trigger('sidebar.tokenUsage').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps focus on the trigger, so the transcript does not jump', () => {
    renderBubble();
    const usage = trigger('sidebar.tokenUsage');

    // A real tap focuses the button before the click lands.
    usage.focus();
    fireEvent.click(usage);

    const panel = screen.getByRole('dialog');
    // Radix focuses its popover content on mount; `Hint` prevents that, so the
    // content is never the active element.
    expect(panel.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(usage);
  });

  it('closes on a second tap, on Escape and on an outside tap', async () => {
    renderBubble();
    const usage = trigger('sidebar.tokenUsage');

    fireEvent.click(usage);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(usage);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(usage);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(usage);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Radix attaches its outside-pointer listener on a macrotask after mount.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // What a tap outside the panel actually dispatches: Radix defers the
    // pointer-down dismissal to the click that completes the tap.
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not open on hover: a finger has none, and a pen hovering must not stick', async () => {
    renderBubble();

    fireEvent.pointerMove(trigger('sidebar.tokenUsage'));
    // Longer than the tooltip's 300ms delay, so a stray hover path would show.
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the exact message time from a real button, not a bare <time>', () => {
    const { container } = renderBubble();

    const time = container.querySelector('time')!;
    const button = time.closest('button');
    expect(button).not.toBeNull();
    // The relative label stays the visible text; the exact date travels in the
    // accessible name so it is announced without opening the panel.
    expect(button!.textContent).toContain(time.textContent!);

    fireEvent.click(button!);
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain(button!.getAttribute('aria-label') ?? '');
    expect(panel.textContent).toMatch(/\d/);
  });

  it('opens the context gauge breakdown by tapping the ring', () => {
    render(
      <ContextUsageRing
        usage={{
          tokens: 10_000,
          contextWindow: 1_000_000,
          percent: 1,
          estimated: false,
          inputTokens: 9_000,
          outputTokens: 1_000,
          trailingTokens: 0,
        }}
        pendingTokens={0}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('sidebar.contextUsage');
    expect(panel.textContent).toContain('sidebar.contextRemaining');
  });
});

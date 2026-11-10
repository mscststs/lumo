// @vitest-environment jsdom
/**
 * The timestamp closes the toolbar and obeys the same role filter as copy and
 * delete. Pinned here because a partial toolbar record used to resolve `time`
 * to `undefined`, which the bubble reads as "hidden".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { formatMessageTimeTitle } from '@/lib/message-time';
import type { ChatMessage, MessageToolbarSettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { MessageTimestamp } = await import('@/components/chat/MessageTimestamp');

afterEach(cleanup);

const FIVE_MINUTES_AGO = Date.now() - 5 * 60_000;

const USER: ChatMessage = {
  id: 'u1',
  role: 'user',
  timestamp: FIVE_MINUTES_AGO,
  parts: [{ type: 'text', text: 'hello' }],
};

const ASSISTANT: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  timestamp: FIVE_MINUTES_AGO,
  parts: [{ type: 'text', text: 'hi' }],
};

function toolbar(overrides: Partial<MessageToolbarSettings>): MessageToolbarSettings {
  return {
    copy: 'hidden',
    regenerate: 'hidden',
    delete: 'hidden',
    usage: 'hidden',
    time: 'all',
    ...overrides,
  };
}

describe('MessageTimestamp', () => {
  it('renders a relative label with the full date in a toolbar tooltip', async () => {
    const exact = formatMessageTimeTitle(FIVE_MINUTES_AGO, 'en-US');
    // `delayDuration: 0` stands in for the provider `MessageActions` supplies;
    // the assertion is about which surface carries the date, not the wait.
    render(
      <TooltipProvider delayDuration={0}>
        <MessageTimestamp timestamp={FIVE_MINUTES_AGO} />
      </TooltipProvider>,
    );
    const time = screen.getByText('5 minutes ago');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe(new Date(FIVE_MINUTES_AGO).toISOString());
    // No native `title`: it would pop up *alongside* the Radix tooltip.
    expect(time.getAttribute('title')).toBeNull();
    // Assistive tech still gets the exact date, not "5 minutes ago".
    expect(time.getAttribute('aria-label')).toBe(exact);

    fireEvent.pointerMove(time);
    expect((await screen.findByRole('tooltip')).textContent).toBe(exact);
  });

  it('wears the same chrome as the copy and delete buttons', () => {
    const { container } = render(<MessageBubble message={USER} toolbar={toolbar({ copy: 'all', delete: 'all' })} />);
    const time = container.querySelector('time')!;
    const buttons = Array.from(container.querySelectorAll('button'));
    // One shared class string, so the hover wash and the hit-area height cannot
    // drift apart again.
    expect(buttons.length).toBeGreaterThan(0);
    for (const shared of ['h-6', 'rounded-md', 'hover:bg-accent', 'hover:text-foreground', 'transition-colors']) {
      expect(time.className).toContain(shared);
      expect(buttons[0]!.className).toContain(shared);
    }
  });

  it('follows the role filter like copy and delete', () => {
    const { container: userOnly } = render(
      <MessageBubble message={ASSISTANT} toolbar={toolbar({ time: 'user' })} />,
    );
    expect(userOnly.querySelector('time')).toBeNull();
    cleanup();

    render(<MessageBubble message={USER} toolbar={toolbar({ time: 'assistant' })} />);
    expect(screen.queryByText('5 minutes ago')).toBeNull();
    cleanup();

    render(<MessageBubble message={ASSISTANT} toolbar={toolbar({ time: 'assistant' })} />);
    expect(screen.getByText('5 minutes ago')).toBeTruthy();
  });

  it('renders nothing when hidden and does not leave an empty action row on a user message', () => {
    const { container } = render(<MessageBubble message={USER} toolbar={toolbar({ time: 'hidden' })} />);
    expect(container.querySelector('time')).toBeNull();
    // The user toolbar is conditional; with every action hidden there is no row.
    expect(container.querySelector('[data-role="user"] .group-hover\\:opacity-100')).toBeNull();
  });

  it('renders nothing for a missing timestamp instead of throwing', () => {
    const legacy = { ...USER, timestamp: 0 };
    const { container } = render(<MessageBubble message={legacy} toolbar={toolbar({})} />);
    expect(container.querySelector('time')).toBeNull();
  });

  it('dates the displayed variant, not the newest generation', () => {
    const message: ChatMessage = {
      ...ASSISTANT,
      variants: [{ id: 'a0', parts: [{ type: 'text', text: 'older' }], timestamp: FIVE_MINUTES_AGO - 2 * 3_600_000 }],
      activeVariantIndex: 0,
    };
    render(<MessageBubble message={message} toolbar={toolbar({})} />);
    expect(screen.getByText('2 hours ago')).toBeTruthy();
  });
});

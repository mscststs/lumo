// @vitest-environment jsdom
/**
 * The timestamp closes the toolbar and obeys the same role filter as copy and
 * delete. Pinned here because a partial toolbar record used to resolve `time`
 * to `undefined`, which the bubble reads as "hidden".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ChatMessage, MessageToolbarSettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');

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
  it('renders a relative label with the full date in `title`', () => {
    const { container } = render(<MessageBubble message={USER} toolbar={toolbar({})} />);
    const time = container.querySelector('time');
    expect(time).not.toBeNull();
    expect(time!.textContent).toBe('5 minutes ago');
    expect(time!.getAttribute('datetime')).toBe(new Date(FIVE_MINUTES_AGO).toISOString());
    // `dateStyle: 'full'` always names the year, whatever the current one is.
    expect(time!.getAttribute('title')).toContain(
      String(new Date(FIVE_MINUTES_AGO).getFullYear()),
    );
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

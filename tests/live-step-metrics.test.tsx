// @vitest-environment jsdom
/**
 * The live metrics row sits in the reply's action slot while the turn streams,
 * and hands that slot back to the toolbar when it settles. It carries no copy —
 * the timer/gauge icons and the units are the whole legend — so these tests
 * assert the numbers themselves.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types';
import type { StepMetrics } from '@/lib/step-metrics';

vi.mock('react-i18next', () => ({
  // `MessageTimestamp` formats through `Intl` with the active locale, so the
  // mock carries the language the real hook always provides.
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const { LiveStepMetrics } = await import('@/components/chat/LiveStepMetrics');
const { MessageBubble } = await import('@/components/chat/MessageBubble');

afterEach(cleanup);

const METRICS: StepMetrics = { step: 0, ttftMs: 1234, tps: 42.14 };

const STREAMING_MESSAGE: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  timestamp: 0,
  parts: [{ type: 'text', text: 'hello', state: 'streaming' }],
};

describe('LiveStepMetrics', () => {
  it('renders both values with tabular digits', () => {
    const { container } = render(<LiveStepMetrics metrics={METRICS} />);
    expect(screen.getByText('1.2s')).toBeTruthy();
    expect(screen.getByText('42.1 T/s')).toBeTruthy();
    // Two glyphs, no written labels.
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('shows only what is measurable yet', () => {
    render(<LiveStepMetrics metrics={{ step: 0, ttftMs: 850, tps: null }} />);
    expect(screen.getByText('850ms')).toBeTruthy();
    expect(screen.queryByText(/T\/s/)).toBeNull();
  });

  it('renders nothing before the first measurement', () => {
    const { container } = render(<LiveStepMetrics metrics={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('MessageBubble live metrics slot', () => {
  it('shows the numbers while streaming', () => {
    render(
      <MessageBubble message={STREAMING_MESSAGE} isStreaming liveMetrics={METRICS} />,
    );
    expect(screen.getByText('1.2s')).toBeTruthy();
    expect(screen.getByText('42.1 T/s')).toBeTruthy();
  });

  it('hides each metric independently when its setting is off', () => {
    const { unmount } = render(
      <MessageBubble
        message={STREAMING_MESSAGE}
        isStreaming
        showTtft={false}
        liveMetrics={METRICS}
      />,
    );
    expect(screen.queryByText('1.2s')).toBeNull();
    expect(screen.getByText('42.1 T/s')).toBeTruthy();
    unmount();

    render(
      <MessageBubble
        message={STREAMING_MESSAGE}
        isStreaming
        showThroughput={false}
        liveMetrics={METRICS}
      />,
    );
    expect(screen.getByText('1.2s')).toBeTruthy();
    expect(screen.queryByText(/T\/s/)).toBeNull();
  });

  it('hands the slot back to the toolbar once settled', () => {
    const settled: ChatMessage = {
      ...STREAMING_MESSAGE,
      parts: [{ type: 'text', text: 'hello', state: 'done' }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    render(<MessageBubble message={settled} liveMetrics={METRICS} />);
    expect(screen.queryByText('1.2s')).toBeNull();
  });
});

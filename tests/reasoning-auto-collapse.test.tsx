// @vitest-environment jsdom
/**
 * Auto-collapsing a finished chain of thought.
 *
 * Reasoning used to be expanded for the rest of a message's life: `defaultOpen`
 * only seeds the first render, so once a live block opened it stayed open after
 * the stream ended and pushed the answer the user was waiting for down the
 * panel. `autoCollapseReasoning` opts into the alternative — show it while it
 * is arriving, then fold it away a beat after it stops.
 *
 * These pin the transition the feature turns on, plus the two states that must
 * not regress: a message rendered from history is collapsed on mount, and with
 * the setting off a finished block stays open exactly as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

// Labels are asserted through their i18n keys, so the test stays valid when the
// copy changes.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { Reasoning } = await import('@/components/ai-elements/reasoning');

/** The trigger's `aria-expanded` is the state, unlike the animated content. */
function isExpanded(container: HTMLElement): boolean {
  return container.querySelector('button')?.getAttribute('aria-expanded') === 'true';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reasoning auto-collapse', () => {
  it('leaves a finished block open when the setting is off', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Reasoning text="thinking" isStreaming autoCollapse={false} />,
    );
    expect(isExpanded(container)).toBe(true);

    rerender(<Reasoning text="thinking" isStreaming={false} autoCollapse={false} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(isExpanded(container)).toBe(true);
  });

  it('collapses a beat after the reasoning stops streaming', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Reasoning text="thinking" isStreaming autoCollapse />);
    expect(isExpanded(container)).toBe(true);

    rerender(<Reasoning text="thinking" isStreaming={false} autoCollapse />);

    // The last streamed lines stay readable for the grace period.
    expect(isExpanded(container)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(isExpanded(container)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(isExpanded(container)).toBe(false);
  });

  it('renders a message from history already collapsed', () => {
    const { container } = render(<Reasoning text="thinking" autoCollapse />);

    expect(isExpanded(container)).toBe(false);
  });

  it('does not fight a block the user opened by hand', () => {
    vi.useFakeTimers();
    const { container } = render(<Reasoning text="thinking" autoCollapse />);
    expect(isExpanded(container)).toBe(false);

    // Opening a settled block inside the grace period cancels the pending fold.
    act(() => {
      container.querySelector('button')!.click();
    });
    expect(isExpanded(container)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(isExpanded(container)).toBe(true);
  });

  it('folds an already-finished block when the setting is turned on', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Reasoning text="thinking" isStreaming={false} autoCollapse={false} />,
    );
    act(() => {
      container.querySelector('button')!.click();
    });
    expect(isExpanded(container)).toBe(true);

    rerender(<Reasoning text="thinking" isStreaming={false} autoCollapse />);
    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(isExpanded(container)).toBe(false);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TokenUsageStats } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { UsagePanel } = await import('@/components/chat/TokenUsageTooltip');

afterEach(cleanup);

/** A turn with `count` steps, mirroring the shape `lib/ai.ts` accumulates. */
function usageWithSteps(count: number): TokenUsageStats {
  const steps = Array.from({ length: count }, (_, step) => ({
    step,
    inputTokens: 20_000 + step * 700,
    outputTokens: 90 + step,
    totalTokens: 20_090 + step * 701,
    cacheReadTokens: 19_800 + step * 700,
  }));
  return {
    inputTokens: 1_200_000,
    outputTokens: 5_400,
    totalTokens: 1_205_400,
    cacheReadTokens: 1_190_000,
    steps,
  };
}

describe('UsagePanel', () => {
  it('keeps the summary outside the scroll area and every step inside it', () => {
    render(<UsagePanel usage={usageWithSteps(57)} />);

    const ledger = screen.getByTestId('token-usage-steps');
    // Everything that must stay readable at any step count — the summary and the
    // "Steps · 57" caption — has to live outside the element that scrolls.
    expect(ledger.textContent).not.toContain('sidebar.tokenTotal');
    expect(ledger.textContent).not.toContain('sidebar.tokenInput');
    const caption = screen.getByText('sidebar.tokenSteps').parentElement!;
    expect(caption.contains(ledger)).toBe(false);
    expect(caption.textContent).toContain('57');

    // All 57 rows are rendered (no virtualization / truncation of the ledger),
    // and the last one is the newest step rather than the first.
    expect(ledger.textContent).toContain('#57');
    expect(ledger.textContent).toContain('#1');
    expect(ledger.textContent).not.toContain('#58');
  });

  it('is the only scroller, so a long turn can never push the panel off-screen', () => {
    const { container } = render(<UsagePanel usage={usageWithSteps(200)} />);

    const scrollers = Array.from(container.querySelectorAll('*')).filter((el) =>
      /overflow-y-auto/.test(el.className),
    );
    expect(scrollers).toHaveLength(1);
    const ledger = screen.getByTestId('token-usage-steps');
    expect(scrollers).toEqual([ledger]);
    // Shrinkable inside a height-clamped flex column: without `min-h-0` the
    // ledger refuses to give way and the panel overflows again.
    expect(ledger.className).toContain('min-h-0');
    expect(ledger.className).toContain('scrollbar-lumo');
  });

  it('draws metric glyphs as icons instead of platform-dependent text', () => {
    const { container } = render(<UsagePanel usage={usageWithSteps(3)} />);

    // The old glyphs came out as a colour emoji (⚡) and two font-dependent
    // arrows on different systems; both are gone from the DOM.
    expect(container.textContent).not.toMatch(/[↑↓⚡]/);
    const ledger = screen.getByTestId('token-usage-steps');
    // Three metrics per row, each with its own svg.
    expect(ledger.querySelectorAll('svg')).toHaveLength(3 * 3);
    // Icons are decorative; the metric name travels in `title`.
    const titled = Array.from(ledger.querySelectorAll('[title]')).map((el) =>
      el.getAttribute('title'),
    );
    expect(titled).toContain('sidebar.tokenInput');
    expect(titled).toContain('sidebar.tokenOutput');
    expect(titled).toContain('sidebar.tokenCacheRead');
  });

  it('keeps the ledger for a single-step turn so its metrics stay reachable', () => {
    render(<UsagePanel usage={usageWithSteps(1)} />);

    // The step row is the only place TTFT / output speed exist once the turn
    // settled; hiding the ledger for 1-step replies would hide them entirely.
    expect(screen.getByTestId('token-usage-steps')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('sidebar.tokenTotal')).toBeTruthy();
  });

  it('renders TTFT and output speed on each step row', () => {
    const usage = usageWithSteps(2);
    usage.steps![0] = { ...usage.steps![0]!, ttftMs: 1200, decodeMs: 2000 };
    usage.steps![1] = { ...usage.steps![1]!, ttftMs: 850, decodeMs: 4000 };
    render(<UsagePanel usage={usage} />);

    const ledger = screen.getByTestId('token-usage-steps');
    // Step 0: 90 tokens over 2s = 45 T/s.
    expect(ledger.textContent).toContain('1.2s');
    expect(ledger.textContent).toContain('45.0 T/s');
    // Step 1: 91 tokens over 4s = 22.75 → 22.8 T/s.
    expect(ledger.textContent).toContain('850ms');
    expect(ledger.textContent).toContain('22.8 T/s');

    // The timings share the token row and the row refuses to wrap; the panel
    // widens instead, which is what keeps them from dropping to a second line.
    const row = screen.getByText('#1').parentElement!;
    expect(row.contains(screen.getByText('1.2s'))).toBe(true);
    expect(row.className).toContain('flex-nowrap');
    expect(row.className).toContain('whitespace-nowrap');
  });

  it('hides each metric independently, leaving the token ledger', () => {
    const usage = usageWithSteps(2);
    usage.steps![0] = { ...usage.steps![0]!, ttftMs: 1200, decodeMs: 2000 };

    const { unmount } = render(
      <UsagePanel usage={usage} showTtft={false} showThroughput={false} />,
    );
    let ledger = screen.getByTestId('token-usage-steps');
    expect(ledger.textContent).not.toContain('1.2s');
    expect(ledger.textContent).not.toContain('T/s');
    expect(ledger.textContent).toContain('#1');
    unmount();

    render(<UsagePanel usage={usage} showTtft={false} />);
    ledger = screen.getByTestId('token-usage-steps');
    expect(ledger.textContent).not.toContain('1.2s');
    expect(ledger.textContent).toContain('45.0 T/s');
  });

  it('omits timings on legacy steps that carry none', () => {
    render(<UsagePanel usage={usageWithSteps(2)} />);

    const ledger = screen.getByTestId('token-usage-steps');
    expect(ledger.textContent).not.toContain('T/s');
    // Three token metrics, no timing glyphs.
    expect(ledger.querySelectorAll('svg')).toHaveLength(6);
  });

  it('renders the summary even when the step list is absent', () => {
    render(
      <UsagePanel
        usage={{ inputTokens: 1_234, outputTokens: 56, totalTokens: 1_290 }}
      />,
    );

    expect(screen.getByText('sidebar.tokenTotal')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByText('1,290')).toBeTruthy();
  });
});

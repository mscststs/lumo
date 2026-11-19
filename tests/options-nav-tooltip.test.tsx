// @vitest-environment jsdom
/**
 * The options navigation collapses to an icon rail below `lg`, which is the only
 * place its labels disappear. They have to come back on hover there — and only
 * there: on a wide window the label is already printed next to the icon, so a
 * second copy in a floating panel would be a tooltip that changes nothing.
 *
 * Pinned here because both halves are invisible to the type system and were both
 * wrong before: the rail relied on the native `title` attribute (unstyled, its
 * own delay, and it double-renders next to a Radix tooltip), and a tooltip
 * rendered regardless of width would fire on the labelled layout too.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { OptionsNav } = await import('@/entrypoints/options/OptionsNav');

afterEach(cleanup);

/** Stands in for `matchMedia`, which jsdom does not implement. */
function stubRail(isRail: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: isRail,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderNav(activeNav: 'ui' | 'models' = 'ui', onNavigate = vi.fn()) {
  render(<OptionsNav activeNav={activeNav} onNavigate={onNavigate} />);
  return { onNavigate, item: screen.getByRole('button', { name: 'options.nav.ui' }) };
}

describe('options nav labels on the icon rail', () => {
  it('reveals the label of the hovered icon', async () => {
    stubRail(true);
    const { item } = renderNav();

    // The native tooltip is gone: it would appear *in addition to* this one.
    expect(item.getAttribute('title')).toBeNull();
    expect(item.getAttribute('aria-label')).toBe('options.nav.ui');

    fireEvent.pointerMove(item);

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('options.nav.ui');
    // Opened away from the window edge the rail sits on.
    expect(tip.getAttribute('data-side')).toBe('right');
  });

  it('opens on keyboard focus, where there is no hover at all', async () => {
    stubRail(true);
    const { item } = renderNav();

    fireEvent.focus(item);

    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe('options.nav.ui');
    });
  });

  it('keeps aria-current and navigation working with the tooltip wrapped around', () => {
    stubRail(true);
    const { item, onNavigate } = renderNav();

    expect(item.getAttribute('aria-current')).toBe('page');
    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalledWith('ui');
  });

  it('stays quiet where the label is already printed beside the icon', async () => {
    stubRail(false);
    const { item } = renderNav();

    fireEvent.pointerMove(item);
    // Longer than the tooltip's 300ms delay: a width-independent tooltip would
    // have opened by now.
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('trades the label for the icon without losing the page name', () => {
    stubRail(true);
    const { item } = renderNav('ui');

    // The label is still in the DOM — the `lg:` variant is what hides it — and
    // the accessible name is the same string the tooltip renders.
    const label = item.querySelector('span')!;
    expect(label.textContent).toBe('options.nav.ui');
    expect(label.className).toContain('hidden');
    expect(label.className).toContain('lg:inline');
    expect(item.getAttribute('aria-label')).toBe('options.nav.ui');
    expect(item.querySelector('svg')).not.toBeNull();
  });
});

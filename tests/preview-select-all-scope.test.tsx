// @vitest-environment jsdom
/**
 * Ctrl/Cmd+A in the preview page must select the file, not the page.
 *
 * The browser default range covers every text node, so a select-all followed by
 * a copy pulled the toolbar's file name and MIME label plus the gutter's line
 * numbers into the clipboard — pasted source came back interleaved with digits.
 * `select-none` cannot fix that on its own: it only suppresses pointer-driven
 * selection, the nodes stay inside a document-wide range.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import {
  SELECT_ALL_ROOT_ATTR,
  selectAllRootProps,
  useSelectAllScope,
} from '@/lib/use-select-all-scope';
import { CodeView } from '@/entrypoints/preview/CodeView';

// The Shiki import is lazy and irrelevant here; the raw-source fallback renders.
vi.mock('@/lib/code-highlight', () => ({
  highlightCode: () => Promise.reject(new Error('unused')),
}));

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

/** Dispatch a select-all chord on the window, as the real hook listens there. */
function pressSelectAll(init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe('select-all scope', () => {
  it('selects only the marked root, excluding chrome and gutter', () => {
    const { getByTestId } = render(
      <div>
        <header data-testid="chrome">file.js text/javascript</header>
        <div aria-hidden="true" data-testid="gutter">
          1
        </div>
        <div data-testid="content" {...selectAllRootProps}>
          const a = 1;
        </div>
      </div>,
    );
    renderHook(() => useSelectAllScope());

    const event = pressSelectAll();
    expect(event.defaultPrevented).toBe(true);

    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    const range = selection.getRangeAt(0);
    expect(range.commonAncestorContainer).toBe(getByTestId('content'));
    expect(range.intersectsNode(getByTestId('chrome'))).toBe(false);
    expect(range.intersectsNode(getByTestId('gutter'))).toBe(false);
  });

  it('leaves the browser default alone with no root present', () => {
    render(<div>plain</div>);
    renderHook(() => useSelectAllScope());

    expect(pressSelectAll().defaultPrevented).toBe(false);
  });

  it('does not hijack a text field, extra modifiers, or other keys', () => {
    const { getByTestId } = render(
      <div>
        <input data-testid="field" />
        <div {...selectAllRootProps}>code</div>
      </div>,
    );
    renderHook(() => useSelectAllScope());

    (getByTestId('field') as HTMLInputElement).focus();
    expect(pressSelectAll().defaultPrevented).toBe(false);

    (document.activeElement as HTMLElement).blur();
    expect(pressSelectAll({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(pressSelectAll({ altKey: true }).defaultPrevented).toBe(false);
    // Ctrl+Cmd+A is a different chord entirely.
    expect(pressSelectAll({ metaKey: true }).defaultPrevented).toBe(false);
    expect(pressSelectAll({ key: 's' }).defaultPrevented).toBe(false);
  });

  it('accepts Cmd+A without Ctrl, for macOS', () => {
    render(<div {...selectAllRootProps}>code</div>);
    renderHook(() => useSelectAllScope());

    expect(
      pressSelectAll({ ctrlKey: false, metaKey: true }).defaultPrevented,
    ).toBe(true);
  });

  it('stops listening after unmount', () => {
    render(<div {...selectAllRootProps}>code</div>);
    const { unmount } = renderHook(() => useSelectAllScope());
    unmount();

    expect(pressSelectAll().defaultPrevented).toBe(false);
  });
});

describe('CodeView selection surface', () => {
  it('puts line numbers outside the select-all root', () => {
    const { container } = render(<CodeView content={'a\nb\nc'} language="javascript" />);

    const root = container.querySelector(`[${SELECT_ALL_ROOT_ATTR}]`);
    expect(root).not.toBeNull();
    expect(root!.textContent).toContain('a');

    const gutter = container.querySelector('[aria-hidden="true"]');
    expect(gutter).not.toBeNull();
    expect(gutter!.textContent).toBe('123');
    // The gutter must not live inside the selectable region.
    expect(root!.contains(gutter!)).toBe(false);
  });
});

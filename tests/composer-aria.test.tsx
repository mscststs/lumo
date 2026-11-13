// @vitest-environment jsdom
/**
 * The composer is an editable combobox for as long as a suggestion menu can
 * open above it.
 *
 * The regression this pins: `role="listbox"` and `aria-activedescendant` used to
 * live on the popup element, which never takes focus. `aria-activedescendant` is
 * only honoured on the element that *has* focus, so arrow-key navigation through
 * slash commands and `@` mentions announced nothing at all — the listbox existed
 * visually and was invisible to assistive technology.
 *
 * The contract now: the textarea owns `role="combobox"`, `aria-expanded`,
 * `aria-controls` and `aria-activedescendant`; the popup owns only `role="listbox"`
 * and its id.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { UISettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const settings = { pasteThreshold: 500, sendKey: 'enter' } as UISettings;

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => settings,
    getMentionSettings: async () => ({ enabled: true, tabsEnabled: true, filesEnabled: true }),
  },
}));

vi.mock('@/store/useCommands', () => ({
  // A built-in command so the slash menu has a row to point at. The real hook
  // would build this from stored settings; only the shape matters here.
  useEnabledCommands: () => [{ kind: 'builtin', id: 'new', name: 'new', action: 'new-chat' }],
  useCommandSettings: () => ({
    settings: { enabled: true, applyTiming: 'send', userCommands: [], disabledBuiltins: [] },
    isLoaded: true,
    setSettings: async () => {},
  }),
}));

vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: () => {},
}));

const baseProps = {
  isStreaming: false,
  canAcceptImages: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  isInternalDrag: false,
};

function renderComposer() {
  const view = render(<ChatInput {...baseProps} />);
  const textarea = view.container.querySelector('textarea')!;
  return { ...view, textarea };
}

/**
 * Types `value` into the composer and leaves the caret at its end, which is what
 * opens a suggestion menu. jsdom leaves `selectionStart` at 0 after a synthetic
 * `change`, so the caret is placed explicitly before firing `select` — the hook
 * ChatInput listens to for caret tracking.
 */
function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.select(textarea);
}

describe('composer combobox wiring', () => {
  it('exposes the textarea as a collapsed combobox with an accessible name', () => {
    const { textarea } = renderComposer();
    expect(textarea.getAttribute('role')).toBe('combobox');
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    // No menu open, so there is nothing to point at.
    expect(textarea.getAttribute('aria-controls')).toBeNull();
    expect(textarea.getAttribute('aria-activedescendant')).toBeNull();
    expect(textarea.getAttribute('aria-label')).toBeTruthy();
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
  });

  it('opens the listbox, controls it, and points at the active option', () => {
    const { textarea, container } = renderComposer();

    type(textarea, '/');

    // Slash commands are built-ins, so the menu has candidates immediately.
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox, 'suggestion menu should be open').not.toBeNull();
    expect(textarea.getAttribute('aria-expanded')).toBe('true');

    const controls = textarea.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(listbox!.id).toBe(controls);

    const activeId = textarea.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const active = container.querySelector(`#${CSS.escape(activeId!)}`);
    expect(active, 'active descendant must resolve to a row').not.toBeNull();
    expect(active!.getAttribute('role')).toBe('option');
  });

  it('does not declare aria-activedescendant on the popup itself', () => {
    const { textarea, container } = renderComposer();
    type(textarea, '/');

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    // It is inert there: the popup never holds focus.
    expect(listbox!.getAttribute('aria-activedescendant')).toBeNull();
  });
});

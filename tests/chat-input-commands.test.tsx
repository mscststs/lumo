// @vitest-environment jsdom
/**
 * Slash commands in the composer: the picker, the keyboard, and send-time
 * expansion. Built on the same render helper shape as the paste tests so the
 * two suites stay interchangeable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { CommandSettings, UISettings } from '@/types';
import { DEFAULT_COMMAND_SETTINGS } from '@/lib/slash-commands';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const uiSettings = { pasteThreshold: 500, sendKey: 'enter' } as UISettings;
let commandSettings: CommandSettings = { ...DEFAULT_COMMAND_SETTINGS };

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => uiSettings,
    getCommandSettings: async () => commandSettings,
  },
}));

vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: () => {},
}));

const baseProps = {
  isStreaming: false,
  isVisionModel: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onCommand: vi.fn(),
  isInternalDrag: false,
};

async function renderInput(props: Partial<typeof baseProps> = {}) {
  const view = render(<ChatInput {...baseProps} {...props} />);
  const textarea = view.container.querySelector('textarea')!;
  await waitFor(() => expect(textarea).toBeTruthy());
  // Let the async command-settings read settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, textarea };
}

function typeValue(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  // `onChange` reads selectionStart off the element; jsdom does not update it
  // from the event target, so set it explicitly and re-sync via select.
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.select(textarea);
}

beforeEach(() => {
  commandSettings = {
    enabled: true,
    disabledBuiltins: [],
    userCommands: [
      { id: 'fy', name: 'fy', phrase: '翻译此页面', enabled: true },
    ],
  };
  baseProps.onSend = vi.fn();
  baseProps.onCommand = vi.fn();
  baseProps.onStop = vi.fn();
});

describe('slash command picker', () => {
  it('opens above the input when the draft starts with /', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/');

    await waitFor(() => {
      expect(container.textContent).toContain('/new');
      expect(container.textContent).toContain('/exit');
      expect(container.textContent).toContain('/fy');
    });
  });

  it('filters as the user types', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/n');

    await waitFor(() => {
      expect(container.textContent).toContain('/new');
      expect(container.textContent).not.toContain('/exit');
      expect(container.textContent).not.toContain('/fy');
    });
  });

  it('completes on Enter without sending', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/n');

    await waitFor(() => expect(textarea.value).toBe('/n'));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe('/new '));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('moves with ArrowDown and Tab', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/');

    await waitFor(() => expect(container.textContent).toContain('/new'));
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe('/exit '));
  });
});

describe('send-time resolution', () => {
  it('expands a user command and keeps the trailing text', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/fy 这一段');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('翻译此页面 这一段', [], []);
    });
    expect(textarea.value).toBe('');
  });

  it('dispatches a built-in action and keeps the rest of the draft', async () => {
    const onCommand = vi.fn();
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onCommand, onSend });
    typeValue(textarea, '/new keep me');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('new-chat');
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('keep me');
  });

  it('dispatches close-panel for /exit', async () => {
    const onCommand = vi.fn();
    const { textarea } = await renderInput({ onCommand });
    typeValue(textarea, '/exit');
    // First Enter completes the trigger (the picker is open); the second,
    // with the menu closed, sends the resolved command.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(textarea.value).toBe('/exit '));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('close-panel');
    });
  });

  it('sends ordinary text unchanged', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, 'hello');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('hello', [], []);
    });
  });

  it('does not expand a slash that is not at the very start', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    // Leading space turns the slash into prose: the picker never opened, so
    // send must agree and deliver the draft verbatim.
    typeValue(textarea, ' /fy');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/fy', [], []);
    });
  });

  it('does nothing at all when the master switch is off', async () => {
    commandSettings = { enabled: false, disabledBuiltins: [], userCommands: [] };
    const onSend = vi.fn();
    const onCommand = vi.fn();
    const { textarea, container } = await renderInput({ onSend, onCommand });

    // No picker despite the /:
    typeValue(textarea, '/');
    await waitFor(() => expect(textarea.value).toBe('/'));
    expect(container.textContent).not.toContain('/new');

    // And no resolution on send — the slash is delivered verbatim.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/', [], []);
    });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

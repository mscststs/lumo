// @vitest-environment jsdom
/**
 * A long paste has to leave the composer usable.
 *
 * The failure this guards against is silent in both directions: too eager and a
 * short paste the user meant to edit inline becomes an opaque chip; too timid and
 * a pasted document buries the question under thousands of characters. It also
 * pins the interaction with image paste, which shares the same handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { UISettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const settings = { pasteThreshold: 500, sendKey: 'enter' } as UISettings;

vi.mock('@/store/storage', () => ({
  storage: { getUISettings: async () => settings },
}));

vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: () => {},
}));

const baseProps = {
  isStreaming: false,
  isVisionModel: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  isInternalDrag: false,
};

/** Renders the composer and waits for the async settings read to land. */
async function renderInput(props: Partial<typeof baseProps> = {}) {
  const view = render(<ChatInput {...baseProps} {...props} />);
  const textarea = view.container.querySelector('textarea')!;
  await waitFor(() => expect(textarea).toBeTruthy());
  return { ...view, textarea };
}

/** A paste event carrying text and, optionally, clipboard items. */
function pasteEvent(text: string, items: DataTransferItem[] = []) {
  return {
    clipboardData: {
      items,
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  };
}

beforeEach(() => {
  settings.pasteThreshold = 500;
});

describe('paste as attachment', () => {
  it('leaves a short paste to the textarea', async () => {
    const { textarea } = await renderInput();

    const event = pasteEvent('x'.repeat(499));
    const prevented = !fireEvent.paste(textarea, event);

    // Not prevented means the browser inserts the text itself, as normal.
    expect(prevented).toBe(false);
  });

  it('turns a paste at the threshold into an attachment chip', async () => {
    const { textarea, container } = await renderInput();

    const prevented = !fireEvent.paste(textarea, pasteEvent(`head ${'x'.repeat(500)}`));

    expect(prevented).toBe(true);
    await waitFor(() => {
      expect(container.textContent).toContain('sidebar.pastedAttachment');
    });
    // The draft is untouched — that is the whole point of attaching.
    expect(textarea.value).toBe('');
  });

  it('honours the never setting whatever the size', async () => {
    settings.pasteThreshold = 0;
    const { textarea } = await renderInput();

    const prevented = !fireEvent.paste(textarea, pasteEvent('x'.repeat(50_000)));

    expect(prevented).toBe(false);
  });

  it('attaches every non-empty paste when set to always', async () => {
    settings.pasteThreshold = 1;
    const { textarea, container } = await renderInput();

    fireEvent.paste(textarea, pasteEvent('hi'));

    await waitFor(() => {
      expect(container.textContent).toContain('sidebar.pastedAttachment');
    });
  });

  it('does not also attach text when an image was pasted', async () => {
    // A copy from a page puts both an image and its alt text on the clipboard.
    // Attaching both would duplicate the same content in two forms.
    settings.pasteThreshold = 1;
    const imageItem = {
      type: 'image/png',
      kind: 'file',
      getAsFile: () => null,
    } as unknown as DataTransferItem;

    const { textarea, container } = await renderInput({ isVisionModel: true });

    fireEvent.paste(textarea, pasteEvent('some alt text', [imageItem]));

    await waitFor(() => expect(textarea.value).toBe(''));
    expect(container.textContent).not.toContain('sidebar.pastedAttachment');
  });
});

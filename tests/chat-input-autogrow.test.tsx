// @vitest-environment jsdom
/**
 * The composer's growth cap has to be *measured*, not assumed.
 *
 * The previous cap was a hardcoded 20px line height times five lines. That was
 * correct only at the default 16px font size: `lib/font-size.ts` writes
 * `html { font-size }`, the composer is `text-sm`, so at 18px the same 100px
 * showed 4.4 lines instead of five. These tests pin the cap to the element's
 * computed line height, to the viewport fraction that keeps a short sidepanel
 * usable, and to the re-measure that a font-size setting change triggers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
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
  useEnabledCommands: () => [],
  useCommandSettings: () => ({
    settings: { enabled: true, applyTiming: 'send', userCommands: [], disabledBuiltins: [] },
    isLoaded: true,
    setSettings: async () => {},
  }),
}));

/** Captured so a test can replay the options-page font-size change. */
const watcher = vi.hoisted(() => ({
  current: null as ((value: UISettings) => void) | null,
}));
vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: (_key: string, callback: (value: UISettings) => void) => {
    watcher.current = callback;
  },
}));

const baseProps = {
  isStreaming: false,
  canAcceptImages: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  isInternalDrag: false,
};

/** What `getComputedStyle(textarea).lineHeight` reports for the current test. */
let lineHeight = '20px';
let innerHeight = 768;

/** jsdom lays nothing out, so `scrollHeight` is always 0 and needs a stand-in. */
const SCROLL_HEIGHT = 1000;

async function renderInput() {
  const view = render(<ChatInput {...baseProps} />);
  const textarea = view.container.querySelector('textarea')!;
  await waitFor(() => expect(textarea).toBeTruthy());

  Object.defineProperty(textarea, 'scrollHeight', {
    value: SCROLL_HEIGHT,
    configurable: true,
  });
  // Force a re-measure now that the stand-in scroll height exists.
  act(() => window.dispatchEvent(new Event('resize')));
  return textarea;
}

beforeEach(() => {
  lineHeight = '20px';
  innerHeight = 768;
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
    (el as Element).tagName === 'TEXTAREA'
      ? ({ lineHeight } as unknown as CSSStyleDeclaration)
      : realGetComputedStyle(el as Element),
  );
  Object.defineProperty(window, 'innerHeight', {
    value: innerHeight,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composer auto-grow cap', () => {
  it('caps at ten measured lines and scrolls beyond that', async () => {
    const textarea = await renderInput();
    expect(textarea.style.maxHeight).toBe('200px');
    expect(textarea.style.height).toBe('200px');
  });

  it('moves with the font-size setting instead of assuming a 20px line height', async () => {
    // 18px root × 0.875 × 1.4286 ≈ 22.5px, the setting that showed 4.4 lines.
    lineHeight = '22.5px';
    const textarea = await renderInput();
    expect(textarea.style.maxHeight).toBe('225px');
    expect(textarea.style.height).toBe('225px');
  });

  it('yields to a short viewport so the message list keeps its room', async () => {
    innerHeight = 300;
    Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
    const textarea = await renderInput();
    // min(10 × 20px, 40% of 300px)
    expect(textarea.style.maxHeight).toBe('120px');
    expect(textarea.style.height).toBe('120px');
  });

  it('re-measures when the font-size setting changes mid-draft', async () => {
    const textarea = await renderInput();
    expect(textarea.style.maxHeight).toBe('200px');

    lineHeight = '22.5px';
    act(() => watcher.current?.({ ...settings, fontSize: 18 }));
    expect(textarea.style.maxHeight).toBe('225px');
  });

  it('falls back to 20px when the browser reports `line-height: normal`', async () => {
    lineHeight = 'normal';
    const textarea = await renderInput();
    expect(textarea.style.maxHeight).toBe('200px');
  });
});

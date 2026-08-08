// @vitest-environment jsdom
/**
 * Which panel the debug view inspects when the page opens.
 *
 * Slots are sparse: reordering means the panel on the left can be slot 0, and
 * closing it leaves a layout with no slot 0 at all. The view therefore cannot
 * assume it should read the unsuffixed `currentConversationId` — it has to read
 * whichever slot the published layout says is primary.
 *
 * Getting this wrong is invisible from the code and near-invisible in use: with a
 * single panel open the switcher is hidden, so the page just claims there is no
 * active conversation and offers no way to say otherwise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { Conversation } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'options.chatDebug.panelLeft': 'Left',
        'options.chatDebug.panelMiddle': 'Middle',
        'options.chatDebug.panelRight': 'Right',
      };
      return labels[key] ?? key;
    },
  }),
}));

/** The visible layout the side panel has published. */
let visibleOrder: number[] = [0];

vi.mock('@/store/storage', () => ({
  storage: {
    getSplitViewVisible: async () => ({ order: visibleOrder }),
  },
}));

vi.mock('@/store/useStorageWatch', () => ({ useStorageWatch: () => {} }));

vi.mock('@/entrypoints/options/components/SettingsHeader', () => ({
  SettingsHeader: () => null,
}));

/** Conversations keyed by id, as the database would hold them. */
const database: Record<string, Conversation> = {};

vi.mock('@/lib/conversation-store', () => ({
  getConversation: async (id: string) => database[id] ?? null,
}));

function conversation(id: string, title: string): Conversation {
  return {
    id,
    title,
    messages: [],
    modelId: 'm',
    providerId: 'p',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Panel conversation pointers, as they sit in `chrome.storage.local`. */
let pointers: Record<string, string> = {};

beforeEach(() => {
  visibleOrder = [0];
  pointers = {};
  for (const key of Object.keys(database)) delete database[key];
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in pointers ? { [key]: pointers[key] } : {}),
        set: async () => {},
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
});

afterEach(cleanup);

async function renderDebugPage() {
  const { ChatDebugPage } = await import('@/entrypoints/options/ChatDebug');
  const utils = render(<ChatDebugPage />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return utils;
}

describe('initial panel selection', () => {
  it('reads the unsuffixed key for a single panel in slot 0', async () => {
    visibleOrder = [0];
    pointers.currentConversationId = 'c0';
    database.c0 = conversation('c0', 'Slot zero chat');

    const { container } = await renderDebugPage();

    expect(container.textContent).toContain('Slot zero chat');
  });

  it('finds the conversation when a reorder left the only panel in slot 1', async () => {
    // The exact sequence: split (order [1,0]), drag slot 0 to the left
    // (order [0,1]), close it. Slot 0's pointer is removed with the panel, so
    // reading `currentConversationId` finds nothing and the page used to render
    // its empty state over a sidebar that had an open conversation.
    visibleOrder = [1];
    pointers.currentConversationId_1 = 'c1';
    database.c1 = conversation('c1', 'Survivor chat');

    const { container } = await renderDebugPage();

    expect(container.textContent).toContain('Survivor chat');
    expect(container.textContent).not.toContain('options.chatDebug.noConversation');
  });

  it('defaults to the primary panel, which is the rightmost slot', async () => {
    // Slot 1 was dragged rightmost, so it — not slot 0 — is the primary panel.
    visibleOrder = [0, 1];
    pointers.currentConversationId = 'left';
    pointers.currentConversationId_1 = 'right';
    database.left = conversation('left', 'Left chat');
    database.right = conversation('right', 'Right chat');

    const { container } = await renderDebugPage();

    expect(container.textContent).toContain('Right chat');
    expect(container.textContent).not.toContain('Left chat');
  });

  it('still reports an empty state for a panel with no conversation', async () => {
    // The fix must not paper over the genuine case by borrowing another panel's
    // chat: a fresh panel really has nothing to show.
    visibleOrder = [2];

    const { container } = await renderDebugPage();

    expect(container.textContent).toContain('options.chatDebug.noConversation');
  });
});

describe('switching panels by hand', () => {
  it('follows the user pick instead of the primary panel', async () => {
    visibleOrder = [2, 1];
    pointers.currentConversationId_2 = 'c2';
    pointers.currentConversationId_1 = 'c1';
    database.c2 = conversation('c2', 'Left chat');
    database.c1 = conversation('c1', 'Right chat');

    const { container } = await renderDebugPage();
    expect(container.textContent).toContain('Right chat');

    const leftButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Left',
    )!;
    await act(async () => {
      leftButton.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(container.textContent).toContain('Left chat');
  });
});

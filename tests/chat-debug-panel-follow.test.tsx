// @vitest-environment jsdom
/**
 * The debug view must stay on the panel it is showing when the layout changes
 * underneath it.
 *
 * Reordering panels in the side panel moves no storage: a slot is a panel's
 * identity and keeps its conversation across a drag. Only which panel is
 * *rightmost* changes. A view that resolved its target from the layout on every
 * change therefore swapped itself onto a different panel's chat the instant the
 * user reordered — visibly, as a flash through the loading state onto someone
 * else's conversation, or onto the empty state when the panel dragged rightmost
 * had no chat yet.
 *
 * `chat-debug-panel-selection.test.tsx` covers which panel is picked on open,
 * with the layout watcher stubbed out. This covers the live path, so the watcher
 * is real and layout changes are dispatched through `chrome.storage.onChanged`.
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

/** The visible layout the side panel has published at mount time. */
let visibleOrder: number[] = [1, 0];

vi.mock('@/store/storage', () => ({
  storage: {
    getSplitViewVisible: async () => ({ order: visibleOrder }),
  },
}));

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
/** Every pointer key read, so a needless re-read — i.e. a flash — is visible. */
let pointerReads: string[] = [];

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;
let listeners: StorageListener[] = [];

/** Publishes a layout the way the side panel does, and lets React settle. */
async function publishLayout(order: number[]) {
  await act(async () => {
    for (const listener of [...listeners]) {
      listener({ splitViewVisible: { newValue: { order } } }, 'local');
    }
    await new Promise((r) => setTimeout(r, 30));
  });
}

beforeEach(() => {
  visibleOrder = [1, 0];
  pointers = {};
  pointerReads = [];
  listeners = [];
  for (const key of Object.keys(database)) delete database[key];
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async (key: string) => {
          pointerReads.push(key);
          return key in pointers ? { [key]: pointers[key] } : {};
        },
        set: async () => {},
      },
      onChanged: {
        addListener: (listener: StorageListener) => { listeners.push(listener); },
        removeListener: (listener: StorageListener) => {
          listeners = listeners.filter((l) => l !== listener);
        },
      },
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

/** Two panels: slot 1 on the left, slot 0 rightmost, each with its own chat. */
function twoPanels() {
  visibleOrder = [1, 0];
  pointers.currentConversationId = 'c0';
  pointers.currentConversationId_1 = 'c1';
  database.c0 = conversation('c0', 'Zero chat');
  database.c1 = conversation('c1', 'One chat');
}

describe('a reorder in the side panel', () => {
  it('keeps the view on the panel it was showing', async () => {
    twoPanels();
    const { container } = await renderDebugPage();
    expect(container.textContent).toContain('Zero chat');

    // The drag makes slot 1 rightmost. Slot 0 is now on the left, but it is
    // still the panel this view attached itself to.
    await publishLayout([0, 1]);

    expect(container.textContent).toContain('Zero chat');
    expect(container.textContent).not.toContain('One chat');
  });

  it('does not re-read the conversation, so the view cannot flash', async () => {
    // The flash was the whole page dropping to its loading state while the new
    // panel's conversation was fetched. Nothing to fetch, nothing to flash.
    twoPanels();
    await renderDebugPage();
    pointerReads = [];

    await publishLayout([0, 1]);

    expect(pointerReads).toEqual([]);
  });

  it('relabels the tracked panel by where it now sits', async () => {
    // The panel did move, so the switcher must say so: the selected button was
    // "Right" and has to become "Left".
    twoPanels();
    const { container } = await renderDebugPage();
    const selectedLabel = () =>
      [...container.querySelectorAll('button')]
        .find((b) => !b.className.includes('border-input'))
        ?.textContent?.trim();
    expect(selectedLabel()).toBe('Right');

    await publishLayout([0, 1]);

    expect(selectedLabel()).toBe('Left');
  });
});

describe('a panel leaving the layout', () => {
  it('hands the view to the new primary panel', async () => {
    twoPanels();
    const { container } = await renderDebugPage();
    expect(container.textContent).toContain('Zero chat');

    // Slot 0 is closed, which releases its pointer as well.
    delete pointers.currentConversationId;
    await publishLayout([1]);

    expect(container.textContent).toContain('One chat');
  });

  it('does not go back to a closed panel when its slot is reused', async () => {
    // Slots are handed out lowest-free-first, so a later split reopens slot 0 on
    // an unrelated chat. Holding on to the tracked slot would pull the view onto
    // it behind the user's back.
    twoPanels();
    const { container } = await renderDebugPage();

    delete pointers.currentConversationId;
    await publishLayout([1]);
    expect(container.textContent).toContain('One chat');

    pointers.currentConversationId = 'fresh';
    database.fresh = conversation('fresh', 'Freshly split chat');
    await publishLayout([0, 1]);

    expect(container.textContent).toContain('One chat');
    expect(container.textContent).not.toContain('Freshly split chat');
  });
});

describe('a panel picked by hand', () => {
  it('survives a reorder that moves it', async () => {
    twoPanels();
    const { container } = await renderDebugPage();

    const leftButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Left',
    )!;
    await act(async () => {
      leftButton.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container.textContent).toContain('One chat');

    // Slot 1 — the pick — is dragged rightmost. It is the same panel either way.
    await publishLayout([0, 1]);

    expect(container.textContent).toContain('One chat');
    expect(container.textContent).not.toContain('Zero chat');
  });
});

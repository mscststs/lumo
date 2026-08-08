// @vitest-environment jsdom
/**
 * SplitView must hand every quick action to some panel.
 *
 * The routing decision is already covered as a pure function in
 * `quick-action-routing.test.ts`; what is tested here is the wiring around it,
 * where two cold-open hazards live:
 *
 * 1. The layout is still its initial single panel on the frame the action
 *    dispatches, because it is read asynchronously from storage. Routing must not
 *    use the rendered count to decide which panels exist, or panels 1–2 become
 *    invisible and a busy panel 0 wins by default.
 * 2. An action must never be silently dropped — that is what made the menu look
 *    broken when the panel had been closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { ChatPanelHandle } from '@/components/chat/ChatPanel';
import type { ContextMenuPendingData } from '@/lib/context-menu';
import { CONTEXT_MENU_PENDING_KEY } from '@/lib/context-menu';

/** Per-panel state the stubbed panels report to routing. */
const panelState = new Map<number, { isStreaming: boolean; hasContent: boolean }>();
/** Which panel received the action, and how. */
const applied: { panelId: number; delivery: string }[] = [];

vi.mock('@/components/chat/ChatPanel', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    ChatPanel: forwardRef<ChatPanelHandle, { panelIndex: number }>(function StubPanel(
      { panelIndex },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        addImages: vi.fn(),
        addTextAttachment: vi.fn(),
        focus: vi.fn(),
        getCurrentSessionId: () => null,
        getRoutingState: () =>
          panelState.get(panelIndex) ?? { isStreaming: false, hasContent: false },
        applyQuickAction: (_pending, delivery) => {
          applied.push({ panelId: panelIndex, delivery });
        },
      }));
      return null;
    }),
  };
});

/** The panel layout SplitView will read back from storage. */
let savedPanelCount = 1;

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => ({
      language: 'en',
      theme: 'light',
      maxSplitPanels: 3,
      sendKey: 'enter',
    }),
    // Deliberately slow, so the action dispatches before the layout has been
    // restored — hazard 1 above.
    getSplitViewLayout: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { order: Array.from({ length: savedPanelCount }, (_, i) => savedPanelCount - 1 - i) };
    },
    setSplitViewLayout: async () => {},
    setSplitViewVisible: async () => {},
  },
}));

vi.mock('@/store/useStorageWatch', () => ({ useStorageWatch: () => {} }));
vi.mock('@/lib/panel-storage', () => ({
  releasePanelSlot: vi.fn(),
  openPanelSlot: vi.fn(),
}));

/**
 * Rebuilt per test: `useContextMenuPending` discards payloads older than its
 * 30s TTL, so a hardcoded timestamp would be treated as an abandoned click and
 * never delivered.
 */
function freshPending(): ContextMenuPendingData {
  return {
    actionId: 'lumo-page-translate',
    type: 'page',
    pageContext: { tabId: 5, title: 'T', url: 'u' },
    prompt: 'translate',
    autoSend: true,
    timestamp: Date.now(),
  };
}

let sessionPayload: ContextMenuPendingData | null = null;

/**
 * Makes `ResizeObserver` report a fixed container width.
 *
 * jsdom has no layout, so SplitView measures 0 and caps itself at one panel.
 * Tests that need a sibling panel to mount have to supply a width past the
 * split thresholds.
 */
function stubContainerWidth(width: number) {
  class WidthObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = WidthObserver as unknown as typeof ResizeObserver;
}

beforeEach(() => {
  applied.length = 0;
  panelState.clear();
  sessionPayload = freshPending();
  // A real side panel always has a width. Default to a narrow one (single
  // panel); tests needing a sibling widen it.
  stubContainerWidth(400);
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      // Mirrors real session storage: the payload is read once and the panel
      // removes it, so a second read finds nothing. A stub that kept handing out
      // a fresh payload would mask a double-delivery bug.
      session: {
        get: async () => (sessionPayload ? { [CONTEXT_MENU_PENDING_KEY]: sessionPayload } : {}),
        remove: async () => { sessionPayload = null; },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { openOptionsPage: vi.fn() },
  };
});

async function renderSplitView() {
  const { SplitView } = await import('@/components/chat/SplitView');
  render(<SplitView />);
  // Let the mount-time session read, the slower panel-count read, and the
  // readiness gate that releases the held action all settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
}

describe('SplitView quick action dispatch', () => {
  it('delivers a cold-open action to panel 0 when it is the only panel', async () => {
    savedPanelCount = 1;
    await renderSplitView();
    expect(applied).toEqual([{ panelId: 0, delivery: 'send' }]);
  });

  it('never drops the action, even when panel 0 is busy with a draft', async () => {
    savedPanelCount = 1;
    panelState.set(0, { isStreaming: true, hasContent: true });
    await renderSplitView();
    // Nowhere clean to land, so it must still arrive somewhere as a prefill
    // rather than vanish.
    expect(applied).toEqual([{ panelId: 0, delivery: 'prefill' }]);
  });

  it('routes to an idle sibling instead of a busy panel 0', async () => {
    // Regression for hazard 1: routing must enumerate the panels that actually
    // exist. If it trusted the rendered count — still 1 when the action
    // dispatches — panel 1 would be invisible and this would land on the busy
    // panel 0 as a prefill instead of sending on panel 1.
    savedPanelCount = 2;
    // jsdom reports a 0-wide container, which would cap the layout at one panel.
    // Report a width past the 2-panel threshold so panel 1 really mounts.
    stubContainerWidth(1200);
    panelState.set(0, { isStreaming: true, hasContent: false });
    panelState.set(1, { isStreaming: false, hasContent: false });
    await renderSplitView();
    expect(applied).toEqual([{ panelId: 1, delivery: 'send' }]);
  });

  it('applies the action exactly once', async () => {
    // The mount-time read and the storage-change listener both feed the same
    // consumer; the timestamp guard must keep that to a single delivery.
    savedPanelCount = 1;
    await renderSplitView();
    expect(applied).toHaveLength(1);
  });
});

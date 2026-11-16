// @vitest-environment jsdom
/**
 * The anchored transcript, exercised on a stubbed scroll box.
 *
 * jsdom has no layout, so the geometry a browser would give us is faked here:
 * the scroll box is 500px tall, the content reports `naturalHeight` plus
 * whatever the spacer holds, and every rect follows from the current
 * `scrollTop`. That is enough to pin the behaviour that matters — the question
 * lands at the top the instant it is sent, the reserved room shrinks as the
 * reply grows (so nothing scrolls), and a manual scroll ends the hold.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ChatScrollApi } from '@/components/chat/useChatScroll';

interface Box {
  scrollTop: number;
  clientHeight: number;
  /** Height of the messages alone, i.e. without the reserved spacer. */
  naturalHeight: number;
  /** The question's top edge, in the transcript's scroll coordinates. */
  anchorTop: number;
}

const box: Box = { scrollTop: 0, clientHeight: 500, naturalHeight: 0, anchorTop: 0 };

let latestApi: ChatScrollApi | null = null;

function Harness({ tick }: { tick: number }) {
  const api = useAnchorChatScroll();
  latestApi = api;
  return (
    <div ref={api.scrollRef} data-testid={`scroll-${tick}`}>
      <div ref={api.contentRef} data-testid={`content-${tick}`}>
        <div data-message-id="question" data-testid={`question-${tick}`} />
      </div>
      {/* Sibling of the content element on purpose, as in `ConversationContent`:
          the reserved room must not be part of the measured content. */}
      {api.spacerRef && <div ref={api.spacerRef} data-testid={`spacer-${tick}`} />}
    </div>
  );
}

let useAnchorChatScroll: typeof import('@/components/chat/useChatScroll').useAnchorChatScroll;

/**
 * The pin travels with a spring. These tests are about *where* it lands, so the
 * default is "the reader asked for reduced motion" — an instant write. The
 * animated path is exercised separately.
 */
const media = { reduced: true };

beforeAll(async () => {
  window.matchMedia = ((query: string) => ({
    matches: media.reduced,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  ({ useAnchorChatScroll } = await import('@/components/chat/useChatScroll'));
});

afterEach(() => {
  cleanup();
  latestApi = null;
});

function mountHarness() {
  box.scrollTop = 0;
  box.clientHeight = 500;
  box.naturalHeight = 800;
  box.anchorTop = 700;

  const utils = render(<Harness tick={0} />);
  const scrollEl = utils.getByTestId('scroll-0');
  const contentEl = utils.getByTestId('content-0');
  const questionEl = utils.getByTestId('question-0');
  const spacerEl = utils.getByTestId('spacer-0');

  const spacerHeight = () => Number.parseFloat(spacerEl.style.height || '0') || 0;

  const maxScrollTop = () =>
    Math.max(0, box.naturalHeight + spacerHeight() - box.clientHeight);
  Object.defineProperty(scrollEl, 'scrollTop', {
    configurable: true,
    // A browser clamps both the write and the stored offset when the content
    // shrinks under it (e.g. when the reserved room is released).
    get: () => Math.min(box.scrollTop, maxScrollTop()),
    set: (value: number) => {
      box.scrollTop = Math.max(0, Math.min(value, maxScrollTop()));
    },
  });
  Object.defineProperty(scrollEl, 'clientHeight', {
    configurable: true,
    get: () => box.clientHeight,
  });
  Object.defineProperty(scrollEl, 'scrollHeight', {
    configurable: true,
    get: () => box.naturalHeight + spacerHeight(),
  });

  const rect = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  scrollEl.getBoundingClientRect = () => rect(0, box.clientHeight);

  let tick = 0;
  // Rects follow the *clamped* offset: when content shrinks under the reader the
  // browser pulls the stored offset up, and everything visible moves with it.
  const rewire = () => {
    contentEl.getBoundingClientRect = () => {
      const viewTop = scrollEl.scrollTop;
      return rect(-viewTop, box.naturalHeight);
    };
    questionEl.getBoundingClientRect = () => rect(box.anchorTop - scrollEl.scrollTop, 40);
  };
  rewire();

  return {
    /** The spacer's reserved height, as the DOM holds it. */
    spacerHeight,
    /** The scroll offset the element actually holds (browser-clamped). */
    scrollTop: () => scrollEl.scrollTop,
    api: () => latestApi!,
    /** Another render: the list's layout effect gets a chance to re-anchor. */
    render: () => {
      tick += 1;
      act(() => utils.rerender(<Harness tick={tick} />));
      rewire();
    },
    /** The reply grows by `naturalHeight` in total, then a stream tick renders. */
    grow: (naturalHeight: number) => {
      box.naturalHeight = naturalHeight;
      tick += 1;
      act(() => utils.rerender(<Harness tick={tick} />));
      rewire();
    },
    /** The browser reporting a scroll — ours or the reader's. */
    fireScroll: () => {
      act(() => {
        scrollEl.dispatchEvent(new Event('scroll'));
      });
    },
    /** Drives the controller the way the transcript does. */
    drive: (fn: (api: ChatScrollApi) => void) => {
      act(() => fn(latestApi!));
    },
  };
}

describe('anchored transcript', () => {
  it('puts a just-sent question at the top by reserving the room it lacks', () => {
    const harness = mountHarness();

    harness.drive((api) => api.onTranscriptShown('question'));

    // 100px of transcript sits below the question, so 400px is reserved and the
    // question can be scrolled all the way to the top straight away.
    expect(harness.spacerHeight()).toBe(400);
    expect(harness.scrollTop()).toBe(700);
  });

  it('never scrolls again: the reserved room shrinks as the reply grows', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();
    expect(harness.scrollTop()).toBe(700);

    harness.grow(1000);
    expect(harness.spacerHeight()).toBe(200);
    expect(harness.scrollTop()).toBe(700);

    harness.grow(1500);
    expect(harness.spacerHeight()).toBe(0);
    expect(harness.scrollTop()).toBe(700);
  });

  it('keeps the view frozen once the reply is taller than the screen', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();

    harness.grow(3000);
    harness.grow(9000);

    expect(harness.scrollTop()).toBe(700);
    // Nothing left to reserve, and the reply's end is far below the fold.
    expect(harness.spacerHeight()).toBe(0);
    expect(harness.api().isAtBottom).toBe(false);
  });

  it('releases the hold as soon as the reader scrolls', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();

    // The reader drags the transcript; the event reports an offset we did not
    // ask for, which is how the hook tells their gesture from its own.
    box.scrollTop = 150;
    harness.fireScroll();

    harness.grow(2400);
    expect(harness.scrollTop()).toBe(150);
  });

  it('keeps tracking the reserved room after the reader takes over', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();

    // The reader scrolls down mid-reply: the view is theirs now...
    box.scrollTop = 300;
    harness.fireScroll();
    expect(harness.spacerHeight()).toBe(400);

    // ...but the reserved room still reflects the *current* shortfall, so the
    // answer that outgrows the screen leaves no blank tail behind.
    harness.grow(1400);
    expect(harness.spacerHeight()).toBe(0);
    harness.grow(4000);
    expect(harness.spacerHeight()).toBe(0);
    expect(harness.scrollTop()).toBe(300);
  });

  it('holds the question when a reasoning block collapses under it', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();

    // The thinking block streamed in and the reply outgrew the screen...
    harness.grow(1400);
    expect(harness.spacerHeight()).toBe(0);
    expect(harness.scrollTop()).toBe(700);

    // ...then auto-collapsing it shortens the transcript under the question.
    // The reserved room has to grow back, or the browser clamps the offset and
    // the question slides off the top edge.
    harness.grow(1100);
    expect(harness.spacerHeight()).toBe(100);
    expect(harness.scrollTop()).toBe(700);

    // The reply continues and drains it again: still no blank tail.
    harness.grow(3000);
    expect(harness.spacerHeight()).toBe(0);
    expect(harness.scrollTop()).toBe(700);
  });

  // The browser clamps the offset the instant a transcript gets shorter, and
  // the scroll event it queues is indistinguishable by value from a reader
  // dragging the scrollbar. Only the clamp is compensated, never obeyed.
  it('does not mistake a layout clamp for the reader scrolling', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();
    harness.grow(1400);
    expect(harness.spacerHeight()).toBe(0);

    // The thinking block collapses: the transcript gets shorter than the offset
    // the pin wants, so the browser pulls the offset down and queues an event.
    box.naturalHeight = 1100;
    harness.fireScroll();
    harness.render();
    expect(harness.spacerHeight()).toBe(100);
    expect(harness.scrollTop()).toBe(700);

    // Still pinned: a second collapse is compensated the same way. A pin that
    // had been released here would leave the offset where the clamp dropped it.
    box.naturalHeight = 700;
    harness.fireScroll();
    harness.render();
    expect(harness.spacerHeight()).toBe(500);
    expect(harness.scrollTop()).toBe(700);

    // A real upward scroll still releases it.
    box.naturalHeight = 4000;
    box.scrollTop = 200;
    harness.fireScroll();
    harness.render();
    expect(harness.scrollTop()).toBe(200);
  });

  it('does not move when a turn starts without a new question', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();
    expect(harness.scrollTop()).toBe(700);

    harness.drive((api) => api.onStreamStart());
    expect(harness.scrollTop()).toBe(700);
  });

  it('reports being at the end when the whole reply fits, spacer aside', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();

    // 900px of messages in a 500px box with the question pinned at 700: the
    // reply's end is on screen, so the reserved room must not fake an unread end.
    harness.grow(900);
    expect(harness.api().isAtBottom).toBe(true);
  });

  it('drops the reserved room when a conversation without a question is shown', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    expect(harness.spacerHeight()).toBe(400);

    box.naturalHeight = 0;
    harness.drive((api) => api.onTranscriptShown(null));
    harness.render();

    expect(harness.spacerHeight()).toBe(0);
    expect(harness.scrollTop()).toBe(0);
  });

  it('travels to the pin instead of jumping, and lands on it', async () => {
    media.reduced = false;
    try {
      const harness = mountHarness();
      harness.drive((api) => api.onUserMessageSent('question'));

      // Still on its way: the question is not pinned in the same frame.
      expect(harness.scrollTop()).toBeLessThan(700);

      await waitFor(
        () => expect(Math.abs(harness.scrollTop() - 700)).toBeLessThan(1),
        { timeout: 4000 },
      );
      expect(harness.spacerHeight()).toBe(400);
    } finally {
      media.reduced = true;
    }
  });

  it('lands on a shown conversation outright, without travelling', () => {
    media.reduced = false;
    try {
      const harness = mountHarness();
      harness.drive((api) => api.onTranscriptShown('question'));

      // Opening history must not slide across the whole transcript.
      expect(harness.scrollTop()).toBe(700);
    } finally {
      media.reduced = true;
    }
  });

  it('jumps to the end of the real content and does not re-arm the hold', () => {
    const harness = mountHarness();
    harness.drive((api) => api.onTranscriptShown('question'));
    harness.fireScroll();

    harness.grow(3000);
    harness.drive((api) => api.scrollToBottom());
    // 3000px of content in a 500px box.
    expect(harness.scrollTop()).toBe(2500);
    harness.fireScroll();

    harness.render();
    expect(harness.scrollTop()).toBe(2500);
  });
});

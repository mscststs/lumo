/**
 * Transcript scrolling, in the two modes Personalization offers.
 *
 * Both implementations expose the same surface so the list body stays mode
 * agnostic: the smart parts are here, the markup is shared.
 *
 * - `useAutoChatScroll` — the historical behaviour (and the shipped default):
 *   `use-stick-to-bottom` follows every new token while the reader has not
 *   scrolled away. Nothing about it changes here; it is wrapped, not rewritten.
 *
 * - `useAnchorChatScroll` — the question is pinned to the top of the viewport
 *   the moment it is sent, and the reply is rendered below it. The pin needs
 *   room under the transcript, so the mode reserves it in a spacer
 *   (`lib/chat-scroll.ts` explains the arithmetic); that spacer shrinks as the
 *   reply grows, which is why nothing has to scroll afterwards.
 *
 *   The invariant is `scrollTop - anchorTop = constant`: the question must not
 *   move because something *below* it changed. Two mechanisms provide it, and
 *   both are needed.
 *
 *   1. The reserved room tracks the current shortfall under the anchor in *both*
 *      directions. Growing content drains it (so no scrolling is needed to keep
 *      up); shrinking content — a reasoning block auto-collapsing, a tool card
 *      closing, an image placeholder swapping — refills it. Without the refill
 *      the transcript would get shorter than the pinned offset, the browser
 *      would clamp `scrollTop`, and the question would slide off the top edge.
 *      The room hits zero exactly when the reply is taller than the screen, so
 *      a long reply leaves no blank tail behind.
 *   2. The offset is re-asserted by layout measurement (`ResizeObserver`,
 *      pre-paint) rather than by following the stream, which is why the freeze
 *      costs nothing and jitters at no frame.
 *
 *   Ownership of the scroll is a separate question: the pin is released the
 *   moment the reader scrolls — but a clamp caused by the transcript shrinking
 *   is not a gesture, so it is compensated instead of obeyed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'motion/react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { computeAnchorLayout } from '@/lib/chat-scroll';

export interface ChatScrollApi {
  /** Ref for the scrolling viewport (`ConversationContent`'s scroll element). */
  scrollRef: (element: HTMLElement | null) => void;
  /** Ref for the element whose growth drives the scroll. */
  contentRef: (element: HTMLElement | null) => void;
  /**
   * Ref for the transcript's bottom spacer, or `null` when this mode needs
   * none (auto-scroll). Reserved room, so it must be the last child.
   */
  spacerRef: ((element: HTMLElement | null) => void) | null;
  /**
   * Whether the browser's own scroll anchoring must be switched off for this
   * scroll element. The anchored mode moves the offset itself, and a silent
   * browser correction would be indistinguishable from a reader's gesture.
   */
  disableScrollAnchoring: boolean;
  /** Whether the newest content is in view, i.e. the "jump to latest" is idle. */
  isAtBottom: boolean;
  scrollToBottom: () => void;
  /**
   * A user message was just added by the user (send / interjection). Also the
   * point at which a fresh assistant turn begins.
   */
  onUserMessageSent: (messageId: string) => void;
  /**
   * A transcript became visible — first paint, or a conversation switch — with
   * `messageId` as its newest question (`null` when it has none). Both modes
   * treat that as the reading anchor.
   */
  onTranscriptShown: (messageId: string | null) => void;
  /**
   * An assistant turn began streaming off an existing question (regenerate,
   * retry). No new question is on screen, so the anchored mode stays still.
   */
  onStreamStart: () => void;
}

/** Distance from the end of the real content that still counts as "at the bottom". */
const AT_BOTTOM_THRESHOLD_PX = 24;

/** Sub-pixel slack when deciding whether a scroll event was ours. */
const SCROLL_EPSILON_PX = 1;

/** Slack before rewriting the spacer, so rounding cannot make it oscillate. */
const SPACER_EPSILON_PX = 0.5;

/**
 * How long the pin takes to travel. A spring rather than a tween: the move is a
 * *physical* displacement, it has to be able to absorb a new target mid-flight
 * (the next send) and it must not overshoot past the question it is pinning.
 *
 * `visualDuration` keeps it distance-independent — scrolling two screens and
 * scrolling twenty screens both settle in roughly this time, which is what the
 * eye expects from a jump-to-message gesture.
 */
const PIN_SETTLE_SECONDS = 0.4;

/** Readers who asked the OS to calm motion down get the landing, not the flight. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const noop = () => {};

// ─── auto ───────────────────────────────────────────────────────────────────

export function useAutoChatScroll(): ChatScrollApi {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();

  return useMemo<ChatScrollApi>(
    () => ({
      scrollRef,
      contentRef,
      // Following the bottom needs no reserved room.
      spacerRef: null,
      // `use-stick-to-bottom` relies on it to keep the view stable.
      disableScrollAnchoring: false,
      isAtBottom,
      scrollToBottom: () => void scrollToBottom(),
      // The reader's own send and the start of a reply both land on the newest
      // content in this mode — exactly what this mode is for.
      onUserMessageSent: () => void scrollToBottom(),
      // Showing a conversation keeps the library's behaviour: follow if it is
      // still locked to the bottom, stay put if the reader scrolled away.
      onTranscriptShown: noop,
      onStreamStart: () => void scrollToBottom(),
    }),
    [scrollRef, contentRef, isAtBottom, scrollToBottom],
  );
}

// ─── anchor ─────────────────────────────────────────────────────────────────

export function useAnchorChatScroll(): ChatScrollApi {
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const contentElementRef = useRef<HTMLElement | null>(null);
  const spacerElementRef = useRef<HTMLElement | null>(null);
  /** The question the view is currently held to. */
  const anchorIdRef = useRef<string | null>(null);
  /** The spacer height we last asked for; mirrors what the DOM holds. */
  const spacerHeightRef = useRef(0);
  /**
   * Whether the view is still ours to move. Cleared the moment the reader
   * scrolls, and never re-armed until another question is shown.
   */
  const pinnedRef = useRef(false);
  /**
   * The offset the pin wants, i.e. the question's top at the viewport top.
   * A scroll event reporting anything else is either the reader or — when the
   * wanted offset is currently unreachable — the browser clamping a transcript
   * that just shrank. The two are told apart in `handleScroll`.
   */
  const pinnedTargetRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  /** The in-flight pin/return animation, if any. */
  const animationRef = useRef<ReturnType<typeof animate> | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(false);

  /**
   * Height of the transcript itself. The reserved room lives outside the
   * content element, so this needs no correction for it.
   */
  const readNaturalHeight = useCallback((): number => {
    const contentEl = contentElementRef.current;
    if (contentEl) return contentEl.getBoundingClientRect().height;
    const scrollEl = scrollElementRef.current;
    return scrollEl ? scrollEl.scrollHeight - spacerHeightRef.current : 0;
  }, []);

  /** Highest offset the transcript currently allows. */
  const readMaxScrollTop = useCallback((): number => {
    const scrollEl = scrollElementRef.current;
    if (!scrollEl) return 0;
    return Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  }, []);

  const measureAtBottom = useCallback((): boolean => {
    const scrollEl = scrollElementRef.current;
    if (!scrollEl) return true;
    return (
      readNaturalHeight() - scrollEl.scrollTop - scrollEl.clientHeight <=
      AT_BOTTOM_THRESHOLD_PX
    );
  }, [readNaturalHeight]);

  /** Applies a spacer height, remembering it so redundant writes are skipped. */
  const applySpacer = useCallback((height: number) => {
    spacerHeightRef.current = height;
    const spacerEl = spacerElementRef.current;
    if (spacerEl) spacerEl.style.height = `${height}px`;
  }, []);

  const cancelScrollAnimation = useCallback(() => {
    const animation = animationRef.current;
    animationRef.current = null;
    animation?.stop();
  }, []);

  /**
   * Travels to `target` with the pin animation instead of jumping there.
   *
   * While it runs, `sync` keeps maintaining the reserved room but leaves the
   * offset alone — writing it would both cut the animation short and fight the
   * reader's own scroll.
   */
  const animateScrollTop = useCallback(
    (target: number) => {
      const scrollEl = scrollElementRef.current;
      if (!scrollEl) return;
      cancelScrollAnimation();
      const from = scrollEl.scrollTop;
      if (Math.abs(target - from) < SCROLL_EPSILON_PX) return;
      if (prefersReducedMotion()) {
        scrollEl.scrollTop = target;
        return;
      }
      const animation = animate(from, target, {
        type: 'spring',
        visualDuration: PIN_SETTLE_SECONDS,
        bounce: 0,
        onUpdate: (value: number) => {
          scrollEl.scrollTop = value;
        },
        onComplete: () => {
          if (animationRef.current !== animation) return;
          animationRef.current = null;
        },
      });
      animationRef.current = animation;
    },
    [cancelScrollAnimation],
  );

  const sync = useCallback((animatePin = false) => {
    const scrollEl = scrollElementRef.current;
    if (!scrollEl) return;

    const contentEl = contentElementRef.current;
    // Height the messages alone occupy: the reserved room is not content.
    const naturalHeight = readNaturalHeight();

    const anchorEl = contentEl ? findMessageElement(contentEl, anchorIdRef.current) : null;
    if (contentEl && anchorEl) {
      // The anchor's top edge in the transcript's own scroll coordinates. The
      // viewport's top edge is the origin here (not the content's, which moves
      // with the scroll), so content that changes *above* the anchor is picked
      // up by the next pass instead of being counted twice.
      const anchorTop =
        scrollEl.scrollTop +
        (anchorEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top);
      const layout = computeAnchorLayout({
        clientHeight: scrollEl.clientHeight,
        naturalHeight,
        anchorTop,
        topPadding: readTopPadding(contentEl),
      });

      // The reserved room is a *layout* fact — the current shortfall under the
      // anchor — so it is maintained in both directions and irrespective of who
      // owns the scroll. Refilling matters as much as draining: when a reasoning
      // block auto-collapses under the anchor the transcript gets shorter, and
      // without the refill the browser would clamp `scrollTop` and the question
      // would slide off the top edge. Draining matters because it is what keeps
      // a long reply from leaving a blank tail behind.
      if (Math.abs(layout.spacerHeight - spacerHeightRef.current) >= SPACER_EPSILON_PX) {
        applySpacer(layout.spacerHeight);
      }

      // Only the offset is ownership-dependent: once the reader has scrolled,
      // nothing moves their view again. Clamping here (rather than letting the
      // element clamp the write) keeps a shrunken transcript from being "chased"
      // every frame.
      const maxScrollTop = Math.max(
        0,
        naturalHeight + spacerHeightRef.current - scrollEl.clientHeight,
      );
      const target = Math.min(layout.scrollTop, maxScrollTop);
      pinnedTargetRef.current = pinnedRef.current ? target : null;
      if (pinnedRef.current && !animationRef.current) {
        if (animatePin) {
          animateScrollTop(target);
        } else if (Math.abs(scrollEl.scrollTop - target) >= SCROLL_EPSILON_PX) {
          scrollEl.scrollTop = target;
        }
      }
    }

    const atBottom =
      naturalHeight - scrollEl.scrollTop - scrollEl.clientHeight <=
      AT_BOTTOM_THRESHOLD_PX;
    setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
  }, [animateScrollTop, applySpacer, readNaturalHeight]);

  const scheduleSync = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      sync();
    });
  }, [sync]);

  const holdAnchor = useCallback(
    (messageId: string | null, animatePin: boolean) => {
      anchorIdRef.current = messageId;
      pinnedRef.current = messageId !== null;
      if (messageId === null) {
        // Nothing to hold — release the room a previous question reserved.
        cancelScrollAnimation();
        pinnedTargetRef.current = null;
        applySpacer(0);
      }
      // Called from the list's layout effect, so the reserved room is in place
      // before paint. A send travels there (the reader watches their message
      // rise); showing a saved conversation lands on its question outright — a
      // slide across the whole history would just be visual noise.
      sync(animatePin);
    },
    [applySpacer, cancelScrollAnimation, sync],
  );

  const scrollToBottom = useCallback(() => {
    const scrollEl = scrollElementRef.current;
    // Reading the end of the transcript is an explicit release.
    pinnedRef.current = false;
    pinnedTargetRef.current = null;
    if (!scrollEl) return;
    // The real end, not the reserved bottom: the spacer is not content. Same
    // animation as the pin, so both jumps in this mode feel like one gesture.
    animateScrollTop(Math.max(0, readNaturalHeight() - scrollEl.clientHeight));
    setIsAtBottom(true);
  }, [animateScrollTop, readNaturalHeight]);

  const handleScroll = useCallback(() => {
    const scrollEl = scrollElementRef.current;
    if (!scrollEl) return;

    const target = pinnedTargetRef.current;
    // While the pin animates, every intermediate offset is ours.
    if (pinnedRef.current && !animationRef.current && target !== null) {
      const offset = scrollEl.scrollTop;
      if (Math.abs(offset - target) >= SCROLL_EPSILON_PX) {
        // A scroll event we did not ask for is usually the reader taking over.
        // One other thing can move the offset without any gesture: when the
        // transcript gets *shorter* under the pin (a reasoning block collapsing,
        // a tool card closing) the browser clamps the offset, because the wanted
        // one is momentarily out of range. That clamp arrives here as a smaller
        // offset *and* an unreachable target — `sync` restores it in the same
        // frame, and releasing here would strand the question off the pin.
        const unreachable = offset < target && readMaxScrollTop() < target - SCROLL_EPSILON_PX;
        if (!unreachable) {
          // The reader took over: hold nothing from here on.
          pinnedRef.current = false;
          pinnedTargetRef.current = null;
        }
      }
    }

    const atBottom = measureAtBottom();
    setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
  }, [measureAtBottom, readMaxScrollTop]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      const scrollEl = scrollElementRef.current;
      if (!scrollEl || (!pinnedRef.current && !animationRef.current)) return;
      // Upward intent cancels *before* the next frame can write over the reader's
      // gesture; the scroll event alone can arrive a frame too late.
      if (event.deltaY < 0 && readNaturalHeight() > scrollEl.clientHeight) {
        cancelScrollAnimation();
        pinnedRef.current = false;
      }
    },
    [cancelScrollAnimation, readNaturalHeight],
  );

  const scrollRef = useCallback(
    (element: HTMLElement | null) => {
      const previous = scrollElementRef.current;
      if (previous) {
        previous.removeEventListener('scroll', handleScroll);
        previous.removeEventListener('wheel', handleWheel);
      }
      scrollElementRef.current = element;
      element?.addEventListener('scroll', handleScroll, { passive: true });
      element?.addEventListener('wheel', handleWheel, { passive: true });
    },
    [handleScroll, handleWheel],
  );

  const contentRef = useCallback(
    (element: HTMLElement | null) => {
      contentElementRef.current = element;
      scheduleSync();
    },
    [scheduleSync],
  );

  const spacerRef = useCallback(
    (element: HTMLElement | null) => {
      spacerElementRef.current = element;
      if (element) element.style.height = `${spacerHeightRef.current}px`;
      scheduleSync();
    },
    [scheduleSync],
  );

  // Layout changes that do not come from a React render — a late image, a font
  // swap, an auto-collapsing reasoning block, the panel being resized — still
  // have to be re-anchored. This runs *synchronously*: resize callbacks are
  // delivered after layout and before paint, so compensating here keeps a
  // collapsing block from showing a frame of the question having moved.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => sync());
    if (contentElementRef.current) observer.observe(contentElementRef.current);
    if (scrollElementRef.current) observer.observe(scrollElementRef.current);
    return () => observer.disconnect();
  }, [sync]);

  // Every render of the transcript is a chance for its geometry to have moved;
  // this runs before paint, so a streamed batch never shows up misplaced. The
  // `isAtBottom` read keeps the "jump to latest" affordance honest even when
  // nothing is pinned (an empty chat, a deleted message, a shorter conversation).
  useLayoutEffect(() => {
    sync();
  });

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      cancelScrollAnimation();
    };
  }, [cancelScrollAnimation]);

  return useMemo<ChatScrollApi>(
    () => ({
      scrollRef,
      contentRef,
      spacerRef,
      disableScrollAnchoring: true,
      isAtBottom,
      scrollToBottom,
      onUserMessageSent: (messageId: string) => holdAnchor(messageId, true),
      onTranscriptShown: (messageId: string | null) => holdAnchor(messageId, false),
      // Regenerate/retry: the question is already where the reader left it.
      onStreamStart: noop,
    }),
    [scrollRef, contentRef, spacerRef, isAtBottom, scrollToBottom, holdAnchor],
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** The rendered bubble for a message id, as stamped by the message list. */
function findMessageElement(contentEl: HTMLElement, messageId: string | null): HTMLElement | null {
  if (!messageId) return null;
  const escaped = messageId.replace(/["\\]/g, '\\$&');
  return contentEl.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
}

/**
 * The list's own top padding, so a question held at the top keeps the same
 * breathing room the first message of a conversation has.
 */
function readTopPadding(contentEl: HTMLElement): number {
  const padding = Number.parseFloat(getComputedStyle(contentEl).paddingTop);
  return Number.isFinite(padding) ? padding : 0;
}

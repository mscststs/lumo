/**
 * Transcript scroll mode: value normalisation and the anchored layout.
 *
 * The anchored mode's whole behaviour lives in one calculation, so it is pinned
 * here: it reserves exactly the room the question is missing, which is what lets
 * the question land at the top of the viewport the instant it is sent, and it
 * gives the same scroll offset as the reply grows — the freeze.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_SCROLL_MODES,
  DEFAULT_CHAT_SCROLL_MODE,
  computeAnchorLayout,
  normalizeChatScrollMode,
} from '@/lib/chat-scroll';

describe('normalizeChatScrollMode', () => {
  it('keeps a known mode', () => {
    expect(normalizeChatScrollMode('auto')).toBe('auto');
    expect(normalizeChatScrollMode('anchor')).toBe('anchor');
  });

  it('falls back to the historical behaviour for anything else', () => {
    // Every install written before this setting existed lands here.
    expect(normalizeChatScrollMode(undefined)).toBe(DEFAULT_CHAT_SCROLL_MODE);
    expect(normalizeChatScrollMode(null)).toBe(DEFAULT_CHAT_SCROLL_MODE);
    expect(normalizeChatScrollMode('')).toBe(DEFAULT_CHAT_SCROLL_MODE);
    expect(normalizeChatScrollMode('pinned')).toBe(DEFAULT_CHAT_SCROLL_MODE);
    expect(normalizeChatScrollMode(true)).toBe(DEFAULT_CHAT_SCROLL_MODE);
  });

  it('ships auto-scroll and lists both modes', () => {
    expect(DEFAULT_CHAT_SCROLL_MODE).toBe('auto');
    expect([...CHAT_SCROLL_MODES]).toEqual(['auto', 'anchor']);
  });
});

describe('computeAnchorLayout', () => {
  const clientHeight = 500;

  it('reserves the missing room so a just-sent question reaches the top', () => {
    // The question is 700px down with only 100px of transcript beneath it:
    // without the reserved 400px the browser would clamp the offset to 400 and
    // leave the question stuck at the bottom.
    expect(
      computeAnchorLayout({ clientHeight, naturalHeight: 800, anchorTop: 700 }),
    ).toEqual({ spacerHeight: 400, scrollTop: 700 });
  });

  it('shrinks the reserved room as the reply grows, keeping the offset', () => {
    const atSend = computeAnchorLayout({ clientHeight, naturalHeight: 800, anchorTop: 700 });
    const later = computeAnchorLayout({ clientHeight, naturalHeight: 1000, anchorTop: 700 });

    expect(later.spacerHeight).toBe(200);
    expect(later.scrollTop).toBe(atSend.scrollTop);
  });

  it('reserves nothing once the reply fills the screen', () => {
    expect(
      computeAnchorLayout({ clientHeight, naturalHeight: 2000, anchorTop: 700 }),
    ).toEqual({ spacerHeight: 0, scrollTop: 700 });
  });

  it('keeps the list padding above the question', () => {
    expect(
      computeAnchorLayout({ clientHeight, naturalHeight: 800, anchorTop: 700, topPadding: 12 }),
    ).toEqual({ spacerHeight: 400, scrollTop: 688 });
  });

  it('never scrolls above the start for a question that opens the transcript', () => {
    expect(
      computeAnchorLayout({ clientHeight, naturalHeight: 100, anchorTop: 12, topPadding: 12 }),
    ).toEqual({ spacerHeight: 412, scrollTop: 0 });
  });

  it('reserves the whole viewport for an empty transcript', () => {
    expect(computeAnchorLayout({ clientHeight, naturalHeight: 0, anchorTop: 0 })).toEqual({
      spacerHeight: 500,
      scrollTop: 0,
    });
  });
});

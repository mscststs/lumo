import { describe, it, expect } from 'vitest';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import {
  TITLE_MAX_CHARS,
  conversationTitle,
  deriveConversationTitle,
} from '@/lib/conversation-title';

/**
 * The regression these lock down: the placeholder title used to be the literal
 * string `'New Chat'`, written straight into the conversation record. It reached
 * the history list untranslated, and being persisted it would have stayed
 * untranslated even once localised at write time. So the two halves are tested
 * separately — deriving stores nothing but real content, and displaying is the
 * only place the localised placeholder appears.
 */

/** Stand-in for i18next's `t`, resolving the keys this module names. */
const t = (key: string): string =>
  key === 'sidebar.history.untitled' ? en.sidebar.history.untitled : `!${key}`;

describe('deriveConversationTitle', () => {
  it('takes the opening message, trimmed to the display length', () => {
    expect(deriveConversationTitle('Summarise this page')).toBe('Summarise this page');
    expect(deriveConversationTitle('x'.repeat(TITLE_MAX_CHARS + 20))).toBe(
      'x'.repeat(TITLE_MAX_CHARS),
    );
  });

  it('stores nothing when the opening turn carries no text', () => {
    // An image-only or attachment-only ask. This is the case the placeholder
    // exists for, and the point is that the placeholder is *not* what lands in
    // the record — a UI string frozen into the database cannot follow a
    // language switch.
    expect(deriveConversationTitle('')).toBe('');
    expect(deriveConversationTitle('   \n  ')).toBe('');
  });
});

describe('conversationTitle', () => {
  it('shows the stored title when there is one', () => {
    expect(conversationTitle('Summarise this page', t)).toBe('Summarise this page');
  });

  it('falls back to the localised placeholder for an untitled conversation', () => {
    expect(conversationTitle('', t)).toBe(en.sidebar.history.untitled);
    expect(conversationTitle('   ', t)).toBe(en.sidebar.history.untitled);
  });

  it('has a translation in every shipped language', () => {
    // The bug was a user-facing string that no locale could reach. `zh` is typed
    // as the `en` schema, so a missing key fails to compile — this only has to
    // catch a key present but left in English.
    expect(zh.sidebar.history.untitled).not.toBe(en.sidebar.history.untitled);
    expect(zh.sidebar.history.untitled.length).toBeGreaterThan(0);
  });
});

/**
 * @vitest-environment jsdom
 *
 * The storage usage report behind the about page.
 *
 * The point of the report is that it measures rather than counts: a conversation's
 * cost is dominated by whatever is inline in its messages, so "3 conversations"
 * says nothing about whether history is worth clearing. These tests pin that the
 * numbers track the data, that each area is reported separately, and that a
 * missing capability degrades to "unknown" rather than to a confident zero.
 *
 * Environment caveat, as recorded in `conversation-store.test.ts`:
 * `fake-indexeddb`'s structured clone does not preserve `Blob` instances, so the
 * screenshot *byte* total cannot be exercised here — only that the blobs are
 * counted. Real IndexedDB round-trips the Blob and reports its size.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConversations, saveConversation } from '@/lib/conversation-store';
import { fileStorage } from '@/lib/mcp/file-storage';
import { collectStorageUsage } from '@/lib/storage-usage';
import type { ChatMessagePart, Conversation } from '@/types';

const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A tool part carrying a screenshot, as the registry produces it. */
function screenshotPart(toolCallId: string): ChatMessagePart {
  return {
    type: 'tool-page_screenshot',
    toolCallId,
    state: 'output-available',
    input: {},
    output: {
      content: [
        { type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' },
        { type: 'text', text: 'Screenshot captured (png)' },
      ],
      isError: false,
    },
  } as unknown as ChatMessagePart;
}

function conversation(id: string, text: string, withScreenshot = false): Conversation {
  return {
    id,
    title: id,
    messages: [
      { id: `${id}-m1`, role: 'user', parts: [{ type: 'text', text, state: 'done' }], timestamp: 1 },
      ...(withScreenshot
        ? [
            {
              id: `${id}-m2`,
              role: 'assistant' as const,
              parts: [screenshotPart(`${id}-call`)],
              timestamp: 2,
            },
          ]
        : []),
    ],
    modelId: 'gpt-4o',
    providerId: 'openai',
    createdAt: 1,
    updatedAt: 2,
  };
}

/** `chrome.storage.local` is not read by the report; only the event bus looks
 *  for a `chrome` global, and it tolerates its absence. */
beforeEach(async () => {
  await clearConversations();
  await fileStorage.clearFiles();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collectStorageUsage', () => {
  it('reports nothing stored on a clean profile', async () => {
    const report = await collectStorageUsage();

    expect(report.conversations).toEqual({ count: 0, bytes: 0 });
    expect(report.screenshots).toEqual({ count: 0, bytes: 0 });
    expect(report.files).toEqual({ count: 0, bytes: 0 });
  });

  it('counts conversations and grows with their content', async () => {
    await saveConversation(conversation('conv-1', 'hello'));
    const small = await collectStorageUsage();

    expect(small.conversations.count).toBe(1);
    expect(small.conversations.bytes).toBeGreaterThan(0);

    await saveConversation(conversation('conv-2', 'x'.repeat(10_000)));
    const larger = await collectStorageUsage();

    expect(larger.conversations.count).toBe(2);
    // The second conversation is 10 KB of text, so the total must move by
    // roughly that much — not merely by a per-record constant.
    expect(larger.conversations.bytes).toBeGreaterThan(small.conversations.bytes + 10_000);
  });

  it('counts offloaded screenshots separately from the conversation JSON', async () => {
    await saveConversation(conversation('conv-1', 'take a screenshot', true));
    const report = await collectStorageUsage();

    expect(report.conversations.count).toBe(1);
    // The image was swapped for a blob reference, so it is one blob record and
    // it is not part of the conversation's own line.
    expect(report.screenshots.count).toBe(1);
  });

  it('sums stored files from their metadata', async () => {
    await fileStorage.writeFile('a.txt', 'a'.repeat(500));
    await fileStorage.writeFile('nested/b.txt', 'b'.repeat(1500));
    const report = await collectStorageUsage();

    expect(report.files.count).toBe(2);
    expect(report.files.bytes).toBe(2000);
  });

  it('reports no origin estimate when the browser does not expose one', async () => {
    // jsdom has no `navigator.storage`. `null` rather than zeroes is what lets
    // the UI hide the quota bar instead of claiming an empty profile.
    expect((await collectStorageUsage()).origin).toBeNull();
  });

  it('reports the origin estimate when it is available', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 2048, quota: 8192 }) },
    });
    expect((await collectStorageUsage()).origin).toEqual({ usage: 2048, quota: 8192 });
  });

  it('degrades to zero for an area it cannot read', async () => {
    // One unreadable area must not blank the page out.
    await saveConversation(conversation('conv-1', 'hello'));
    vi.spyOn(fileStorage, 'listFiles').mockRejectedValue(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await collectStorageUsage();

    expect(report.files).toEqual({ count: 0, bytes: 0 });
    // The areas that *are* readable still report.
    expect(report.conversations.count).toBe(1);
  });
});

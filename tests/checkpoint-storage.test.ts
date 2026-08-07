/**
 * @vitest-environment jsdom
 *
 * Guards the storage *budget* of mid-stream checkpointing.
 *
 * Checkpointing an in-flight reply is a crash-safety measure, but it writes
 * repeatedly by design, so it is exactly the kind of feature that can quietly
 * blow up storage. Two properties matter and are asserted here:
 *
 * 1. Nothing goes to `chrome.storage`, whose `local` area is capped at 10 MB
 *    without `unlimitedStorage` and serialises a whole key per write.
 * 2. Repeated checkpoints of the same turn *overwrite* rather than accumulate —
 *    including the screenshot blobs, whose ids used to embed `Date.now()` and so
 *    would have written a fresh copy of every image on every checkpoint.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveConversation, getConversation } from '@/lib/conversation-store';
import {
  getChatDB,
  request,
  BLOBS_STORE,
  CONVERSATIONS_STORE,
  META_STORE,
} from '@/lib/chat-db';
import type { ChatMessage, ChatMessagePart, Conversation } from '@/types';

const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  } as ChatMessagePart;
}

/** An assistant turn as it looks partway through streaming. */
function partialTurn(text: string, withScreenshot: boolean): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      ...(withScreenshot ? [screenshotPart('call_1')] : []),
      { type: 'text', text, state: 'streaming' },
    ] as ChatMessagePart[],
    timestamp: 2,
    interrupted: true,
  };
}

function conversation(assistant: ChatMessage): Conversation {
  return {
    id: 'conv-1',
    title: 'test',
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      assistant,
    ],
    modelId: 'm',
    providerId: 'p',
    createdAt: 0,
    updatedAt: 0,
  };
}

async function countAll() {
  const db = await getChatDB();
  const tx = db.transaction([CONVERSATIONS_STORE, META_STORE, BLOBS_STORE], 'readonly');
  return {
    conversations: await request(tx.objectStore(CONVERSATIONS_STORE).count()),
    meta: await request(tx.objectStore(META_STORE).count()),
    blobs: await request(tx.objectStore(BLOBS_STORE).count()),
  };
}

beforeEach(async () => {
  const db = await getChatDB();
  const tx = db.transaction([CONVERSATIONS_STORE, META_STORE, BLOBS_STORE], 'readwrite');
  tx.objectStore(CONVERSATIONS_STORE).clear();
  tx.objectStore(META_STORE).clear();
  tx.objectStore(BLOBS_STORE).clear();
});

describe('checkpoint storage budget', () => {
  it('never writes to chrome.storage', async () => {
    const set = vi.fn();
    // Any touch of the 10 MB-capped area would show up here.
    vi.stubGlobal('chrome', { storage: { local: { set, get: vi.fn() } } });

    await saveConversation(conversation(partialTurn('partial', true)));

    expect(set).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('overwrites instead of accumulating across many checkpoints of one turn', async () => {
    // Simulates a reply streaming in: the same message id, growing text, the
    // same screenshot — checkpointed 20 times.
    let text = '';
    for (let i = 0; i < 20; i++) {
      text += 'token ';
      await saveConversation(conversation(partialTurn(text, true)), {
        insertIfMissing: i === 0,
      });
    }

    const counts = await countAll();
    // One record, one summary, one blob — regardless of checkpoint count.
    expect(counts).toEqual({ conversations: 1, meta: 1, blobs: 1 });
  });

  it('keeps one blob per screenshot even as the turn grows around it', async () => {
    await saveConversation(conversation(partialTurn('a', true)));
    const afterFirst = await countAll();

    // Read-then-save is the real cycle: reading marks blobs with `lumo-blob:`
    // sentinels, and the next checkpoint re-persists those marked messages.
    const loaded = await getConversation('conv-1');
    expect(loaded).not.toBeNull();
    await saveConversation(loaded!);
    await saveConversation(loaded!);

    expect((await countAll()).blobs).toBe(afterFirst.blobs);
    expect((await countAll()).blobs).toBe(1);
  });

  it('does not resurrect a conversation deleted mid-stream', async () => {
    // The hazard of writing from a late callback: the user deleted the chat, and
    // a checkpoint must not bring it back.
    await saveConversation(conversation(partialTurn('partial', false)), {
      insertIfMissing: false,
    });

    expect(await getConversation('conv-1')).toBeNull();
    expect((await countAll()).conversations).toBe(0);
  });

  it('stores the interrupted flag so a truncated reply is identifiable', async () => {
    await saveConversation(conversation(partialTurn('cut short', false)));

    const loaded = await getConversation('conv-1');
    expect(loaded!.messages[1]!.interrupted).toBe(true);
  });

  it('does not keep base64 image bytes in the conversation record', async () => {
    await saveConversation(conversation(partialTurn('partial', true)));

    const db = await getChatDB();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
    const raw = await request(tx.objectStore(CONVERSATIONS_STORE).get('conv-1'));

    // The record is what gets rewritten on every checkpoint, so the image bytes
    // must not be inside it.
    expect(JSON.stringify(raw)).not.toContain(RED_PNG_DATA);
  });
});

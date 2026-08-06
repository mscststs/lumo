/**
 * Conversation persistence.
 *
 * Owns everything about how chat history is stored, so the rest of the app only
 * deals in `Conversation` / `ConversationMeta` values. See `lib/chat-db.ts` for
 * why this lives in IndexedDB rather than `chrome.storage`.
 *
 * Two policies are enforced here:
 *
 * **Screenshots are offloaded to Blobs.** A tool-produced image arrives as
 * base64 inside a `CallToolResult`, which costs 33% more than the bytes it
 * encodes and bloats every read of the conversation. The model never re-reads
 * them either — `sanitizeToolResultImages` in `lib/ai.ts` strips images from the
 * prompt on every turn — so the payload is swapped for a `blobId` reference and
 * the bytes are stored once, natively, in the `blobs` store. Deleting a
 * conversation collects its blobs.
 *
 * **User-supplied images stay inline.** Unlike screenshots these *are* replayed
 * to the model on every turn (`toUIMessages` → `convertToModelMessages`), so
 * keeping them in the record avoids rehydrating on the hot send path. The rule
 * is: offload what the model never reads again.
 */

import { extractText, normalizeMessage } from '@/lib/message-parts';
import { blobRef, parseBlobRef } from '@/lib/blob-ref';
import {
  BLOBS_STORE,
  BLOB_CONVERSATION_INDEX,
  CONVERSATIONS_STORE,
  META_STORE,
  META_UPDATED_AT_INDEX,
  request,
  withStores,
} from '@/lib/chat-db';
import type { ChatMessage, ChatMessagePart, Conversation } from '@/types';

/**
 * Lightweight summary backing the history list.
 *
 * Exists so rendering the list never deserialises message bodies — the whole
 * reason the previous single-key layout was slow as history grew.
 */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** First line of the last message, for the list subtitle. */
  preview: string;
  messageCount: number;
  providerId: string;
  modelId: string;
}

/** How much of the last message is kept for the list subtitle. */
const PREVIEW_MAX_CHARS = 140;

interface StoredBlob {
  id: string;
  conversationId: string;
  blob: Blob;
}

/** An image content entry inside a `CallToolResult`. */
interface ToolImageContent {
  type: 'image';
  /** Base64 payload — present only before offloading. */
  data?: string;
  /** Reference to the `blobs` store — present after offloading. */
  blobId?: string;
  mimeType?: string;
}

type ToolContent = ToolImageContent | { type: string; [key: string]: unknown };

function isToolImageContent(value: unknown): value is ToolImageContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'image'
  );
}

/** Read the `content` array of a tool part's output, when it has one. */
function toolOutputContent(part: ChatMessagePart): ToolContent[] | undefined {
  const output = (part as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return undefined;
  const content = (output as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ToolContent[]) : undefined;
}

/**
 * Rewrite the `content` array of a tool part's output.
 * Returns the original part untouched when `map` changed nothing, so unaffected
 * messages keep their object identity and React can skip re-rendering them.
 */
function mapToolContent(
  part: ChatMessagePart,
  map: (entry: ToolContent) => ToolContent,
): ChatMessagePart {
  const content = toolOutputContent(part);
  if (!content) return part;

  let changed = false;
  const next = content.map((entry) => {
    const mapped = map(entry);
    if (mapped !== entry) changed = true;
    return mapped;
  });
  if (!changed) return part;

  const output = (part as { output?: unknown }).output as Record<string, unknown>;
  return { ...part, output: { ...output, content: next } } as ChatMessagePart;
}

function mapMessageParts(
  messages: ChatMessage[],
  map: (part: ChatMessagePart) => ChatMessagePart,
): ChatMessage[] {
  return messages.map((message) => {
    if (!message.parts || message.parts.length === 0) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      const mapped = map(part);
      if (mapped !== part) changed = true;
      return mapped;
    });
    return changed ? { ...message, parts } : message;
  });
}

/** Decode a base64 payload into a Blob without a data-URL round trip. */
function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Swap every inline tool screenshot for a blob reference, returning the record
 * to persist plus the blobs that must be written alongside it.
 *
 * Already-offloaded entries are left alone, so re-saving a conversation does not
 * duplicate blobs.
 */
function offloadToolImages(conversation: Conversation): {
  conversation: Conversation;
  blobs: StoredBlob[];
} {
  const blobs: StoredBlob[] = [];

  const messages = mapMessageParts(conversation.messages, (part) =>
    mapToolContent(part, (entry) => {
      if (!isToolImageContent(entry)) return entry;

      // Already offloaded. This is the common case, not an edge case: reading a
      // conversation marks each stored image with a `lumo-blob:` reference, and
      // continuing that conversation re-persists those same messages. Checked
      // before decoding because the marker is not base64 — decoding it would
      // throw on every subsequent turn.
      if (typeof entry.blobId === 'string' || (entry.data && parseBlobRef(entry.data))) {
        // Drop the render-only marker so it never reaches disk.
        const { data: _marker, ...rest } = entry;
        return rest as ToolContent;
      }

      if (typeof entry.data !== 'string') return entry;

      const mimeType = entry.mimeType ?? 'image/png';
      let blob: Blob;
      try {
        blob = base64ToBlob(entry.data, mimeType);
      } catch {
        // Malformed base64: drop the payload rather than fail the whole save.
        // The caption text alongside it still explains what the tool did.
        const { data: _dropped, ...rest } = entry;
        return { ...rest, mimeType };
      }

      const id = `${conversation.id}:${blobs.length}:${Date.now()}`;
      blobs.push({ id, conversationId: conversation.id, blob });

      const { data: _inlined, ...rest } = entry;
      return { ...rest, blobId: id, mimeType };
    }),
  );

  return { conversation: { ...conversation, messages }, blobs };
}

/**
 * Turn stored blob references into sentinel URLs the render path understands.
 *
 * The bytes are deliberately *not* loaded here: a conversation can hold dozens
 * of screenshots and only the expanded ones are ever shown, so resolution is
 * left to the component that decides to display one.
 */
function markBlobReferences(conversation: Conversation): Conversation {
  const messages = mapMessageParts(conversation.messages, (part) =>
    mapToolContent(part, (entry) => {
      if (!isToolImageContent(entry) || typeof entry.blobId !== 'string') return entry;
      return { ...entry, data: blobRef(entry.blobId) };
    }),
  );
  return { ...conversation, messages };
}

/**
 * Load the bytes behind a sentinel URL as an object URL.
 *
 * The caller owns the returned URL and must revoke it. Returns `null` when the
 * blob is gone (e.g. discarded by the migration), letting the UI degrade to the
 * tool's caption instead of showing a broken image.
 */
export async function resolveBlobUrl(ref: string): Promise<string | null> {
  const id = parseBlobRef(ref);
  if (!id) return null;

  const stored = await withStores([BLOBS_STORE], 'readonly', (tx) =>
    request<StoredBlob | undefined>(tx.objectStore(BLOBS_STORE).get(id)),
  );
  return stored ? URL.createObjectURL(stored.blob) : null;
}

function buildMeta(conversation: Conversation): ConversationMeta {
  const last = conversation.messages[conversation.messages.length - 1];
  const preview = last
    ? extractText(normalizeMessage(last)).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_CHARS)
    : '';

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    preview,
    messageCount: conversation.messages.length,
    providerId: conversation.providerId,
    modelId: conversation.modelId,
  };
}

/** History list contents, most recently updated first. */
export async function listConversationMeta(): Promise<ConversationMeta[]> {
  const all = await withStores([META_STORE], 'readonly', (tx) =>
    request<ConversationMeta[]>(
      tx.objectStore(META_STORE).index(META_UPDATED_AT_INDEX).getAll(),
    ),
  );
  // The index yields ascending order; the list shows newest first.
  return all.reverse();
}

/** Read one conversation in full, with blob references marked for rendering. */
export async function getConversation(id: string): Promise<Conversation | null> {
  const stored = await withStores([CONVERSATIONS_STORE], 'readonly', (tx) =>
    request<Conversation | undefined>(tx.objectStore(CONVERSATIONS_STORE).get(id)),
  );
  return stored ? markBlobReferences(stored) : null;
}

/**
 * Write a conversation and its summary in one transaction.
 *
 * `insertIfMissing: false` makes the write a no-op for a conversation that no
 * longer exists, so a stream settling after the user deleted it cannot
 * resurrect it. Returns whether anything was written.
 */
export async function saveConversation(
  conversation: Conversation,
  { insertIfMissing = true }: { insertIfMissing?: boolean } = {},
): Promise<boolean> {
  const { conversation: record, blobs } = offloadToolImages(conversation);
  const meta = buildMeta(record);

  return withStores(
    [CONVERSATIONS_STORE, META_STORE, BLOBS_STORE],
    'readwrite',
    async (tx) => {
      const store = tx.objectStore(CONVERSATIONS_STORE);

      if (!insertIfMissing) {
        const existing = await request<Conversation | undefined>(store.get(conversation.id));
        if (!existing) return false;
      }

      store.put(record);
      tx.objectStore(META_STORE).put(meta);

      const blobStore = tx.objectStore(BLOBS_STORE);
      for (const blob of blobs) blobStore.put(blob);

      return true;
    },
  );
}

/** Delete a conversation along with its summary and screenshots. */
export async function deleteConversation(id: string): Promise<void> {
  await withStores(
    [CONVERSATIONS_STORE, META_STORE, BLOBS_STORE],
    'readwrite',
    async (tx) => {
      tx.objectStore(CONVERSATIONS_STORE).delete(id);
      tx.objectStore(META_STORE).delete(id);

      const index = tx.objectStore(BLOBS_STORE).index(BLOB_CONVERSATION_INDEX);
      const ids = await request<IDBValidKey[]>(index.getAllKeys(id));
      const blobStore = tx.objectStore(BLOBS_STORE);
      for (const key of ids) blobStore.delete(key);
    },
  );
}

/** Delete all conversations, summaries and screenshots. */
export async function clearConversations(): Promise<void> {
  await withStores(
    [CONVERSATIONS_STORE, META_STORE, BLOBS_STORE],
    'readwrite',
    (tx) => {
      tx.objectStore(CONVERSATIONS_STORE).clear();
      tx.objectStore(META_STORE).clear();
      tx.objectStore(BLOBS_STORE).clear();
    },
  );
}

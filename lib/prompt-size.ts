/**
 * Prompt-size measurement — the single price list for context accounting.
 *
 * Every surface that needs to know "how big is the prompt" (the composer ring,
 * the pre-send compaction threshold, the between-step wire compaction) goes
 * through this module. They used to be three independent estimators and
 * disagreed by orders of magnitude: a tool result carrying a screenshot was
 * serialised whole, so a single 1.5MB base64 payload read as ~375K tokens while
 * the real prompt carried a ~1.2K-token image — or, once replayed, no image at
 * all.
 *
 * The rule is: **never measure raw image bytes as text.** An image costs
 * {@link IMAGE_CHARS} of text-equivalent budget — the same bound pi uses — and
 * whether it is charged at all depends on whether the prompt actually carries
 * it:
 *
 * - `live` — the current turn's tool image, which `buildImageUserMessage`
 *   injects once into the next request.
 * - `replayed` — a stored message, whose tool images `sanitizeToolResultImages`
 *   strips before every request. Only the caption survives, so only the caption
 *   is charged.
 *
 * Base64 can still hide in shapes we do not model (provider metadata, a data
 * URL embedded in prose), so unknown payloads are serialised with image data
 * replaced by a short marker. Measurement is then bounded by the payload's real
 * text, not by its byte count.
 */

import type { ModelMessage } from 'ai';
import type { ChatMessagePart } from '@/types';

/** Conservative chars-per-token ratio shared by every estimator. */
const CHARS_PER_TOKEN = 4;

/** Character cost assumed for one image (≈1200 tokens, matching pi). */
export const IMAGE_CHARS = 4800;

/** Marker that replaces an image payload before its text is measured. */
const IMAGE_PLACEHOLDER = '[image]';

/** Prefix of an inline base64 image URL. */
const IMAGE_DATA_URL_PREFIX = 'data:image/';

/** Whether the prompt being measured replays an image or strips it. */
export type ImageAccounting = 'replayed' | 'live';

/** Convert measured characters to the token budget they consume. */
export function estimateCharsToTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Replace base64 image data-URLs with a short placeholder. */
export function compactifyImageData(text: string): string {
  if (!text.includes(IMAGE_DATA_URL_PREFIX)) return text;
  return text.replace(/data:image\/[^;,)]+;base64,[A-Za-z0-9+/=]+/g, IMAGE_PLACEHOLDER);
}

// ---------------------------------------------------------------------------
// Payload primitives
// ---------------------------------------------------------------------------

/** Whether a value is an image payload from any of the shapes we have seen. */
function isImagePayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; mediaType?: unknown; data?: unknown };
  if (record.type === 'image' && typeof record.data === 'string') return true;
  return (
    record.type === 'file' &&
    typeof record.mediaType === 'string' &&
    record.mediaType.startsWith('image/')
  );
}

/** Text of a payload string, with any embedded image data stripped. */
function measureTextChars(text: string): number {
  return compactifyImageData(text).length;
}

/**
 * Measured size of an arbitrary value, charging image payloads a bounded
 * constant instead of their byte length.
 */
function measureJsonChars(value: unknown, imageChars: number): number {
  let images = 0;
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'string') return compactifyImageData(val);
      if (isImagePayload(val)) {
        images += 1;
        return IMAGE_PLACEHOLDER;
      }
      return val;
    });
  } catch {
    // Circular or otherwise unserialisable: fall back to a gross description so
    // a broken payload cannot make the estimate collapse to zero.
    return String(value).length;
  }
  return (json?.length ?? 0) + images * imageChars;
}

/**
 * Measured size of one content entry, in any of the shapes that reach us:
 * a UI part, a `CallToolResult` content entry, or a wire content part.
 */
function measureContentPartChars(part: unknown, imageChars: number): number {
  if (typeof part === 'string') {
    return part.startsWith(IMAGE_DATA_URL_PREFIX) ? imageChars : measureTextChars(part);
  }
  if (!part || typeof part !== 'object') return 0;

  const record = part as Record<string, unknown>;
  switch (record.type) {
    case 'text':
      return typeof record.text === 'string' ? measureTextChars(record.text) : 0;
    case 'reasoning':
      return typeof record.text === 'string' ? record.text.length : 0;
    case 'image':
      return imageChars;
    case 'file': {
      const mediaType = typeof record.mediaType === 'string' ? record.mediaType : '';
      // An image file follows the same replay/strip rule as an image block; a
      // non-image file is opaque bytes and gets the same bounded charge.
      return mediaType.startsWith('image/') ? imageChars : IMAGE_CHARS;
    }
    case 'tool-call': {
      const name = typeof record.toolName === 'string' ? record.toolName : '';
      return name.length + measureJsonChars(record.input ?? '', 0);
    }
    case 'tool-result':
      return measureToolOutputChars(record.output, 'replayed');
    default:
      return measureJsonChars(part, imageChars);
  }
}

function measureContentPartsChars(parts: readonly unknown[], imageChars: number): number {
  let chars = 0;
  for (const part of parts) chars += measureContentPartChars(part, imageChars);
  return chars;
}

// ---------------------------------------------------------------------------
// Tool output
// ---------------------------------------------------------------------------

/**
 * Measured size of a tool result payload.
 *
 * Recognises the four shapes that reach us: a bare string, a `CallToolResult`
 * (`{ content: [...] }`), the AI SDK's model-output wrappers (`{ type: 'json' |
 * 'content' | 'text', value }`), and anything else as opaque JSON.
 */
export function measureToolOutputChars(
  output: unknown,
  mode: ImageAccounting,
): number {
  const imageChars = mode === 'live' ? IMAGE_CHARS : 0;

  if (output == null) return 0;
  if (typeof output === 'string') {
    return output.startsWith(IMAGE_DATA_URL_PREFIX) ? imageChars : measureTextChars(output);
  }
  if (Array.isArray(output)) return measureContentPartsChars(output, imageChars);
  if (typeof output !== 'object') return String(output).length;

  const record = output as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    return measureContentPartsChars(record.content, imageChars);
  }
  if (record.type === 'content' && Array.isArray(record.value)) {
    return measureContentPartsChars(record.value, imageChars);
  }
  if (record.type === 'json' || record.type === 'error-json') {
    return measureJsonChars(record.value, imageChars);
  }
  if (
    (record.type === 'text' || record.type === 'error-text') &&
    typeof record.value === 'string'
  ) {
    return measureTextChars(record.value);
  }
  return measureJsonChars(output, imageChars);
}

// ---------------------------------------------------------------------------
// UI parts (stored message / in-flight reply)
// ---------------------------------------------------------------------------

/** Whether a UI part is a tool invocation (static `tool-*` or `dynamic-tool`). */
function isToolPart(part: ChatMessagePart): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

function toolPartName(part: ChatMessagePart): string {
  if (part.type === 'dynamic-tool') {
    return (part as { toolName?: string }).toolName ?? 'tool';
  }
  return part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : part.type;
}

/** Measured size of one stored/streamed message part. */
export function measureUIPartChars(
  part: ChatMessagePart,
  mode: ImageAccounting,
): number {
  if (part.type === 'text') return measureTextChars(part.text);
  if (part.type === 'reasoning') return part.text.length;
  // A user-supplied image is replayed on every request, so it is always charged.
  if (part.type === 'file') return IMAGE_CHARS;

  if (isToolPart(part)) {
    const record = part as unknown as {
      input?: unknown;
      output?: unknown;
      errorText?: unknown;
    };
    let chars = toolPartName(part).length;
    chars += measureJsonChars(record.input ?? '', 0);
    chars += measureToolOutputChars(record.output, mode);
    if (typeof record.errorText === 'string') {
      chars += measureTextChars(record.errorText);
    }
    return chars;
  }

  return measureJsonChars(part, mode === 'live' ? IMAGE_CHARS : 0);
}

/** Measured size of an ordered part list. */
export function measureUIPartsChars(
  parts: readonly ChatMessagePart[],
  mode: ImageAccounting,
): number {
  let chars = 0;
  for (const part of parts) chars += measureUIPartChars(part, mode);
  return chars;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

/**
 * Measured size of one wire (`ModelMessage`) message.
 *
 * Wire prompts are measured after `sanitizeToolResultImages`, so tool-result
 * images are already gone; the only image a wire message can carry is a
 * user-supplied `file` part or the synthetic image message the loop injects.
 * Both are charged {@link IMAGE_CHARS}.
 */
export function measureModelMessageChars(message: ModelMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return measureTextChars(content);
  if (!Array.isArray(content)) return measureJsonChars(content ?? '', IMAGE_CHARS);
  return measureContentPartsChars(content, IMAGE_CHARS);
}

/** Measured size of an ordered wire message list. */
export function measureModelMessagesChars(messages: readonly ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += measureModelMessageChars(message);
  return chars;
}

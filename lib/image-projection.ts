/**
 * Image Projection for non-vision models.
 *
 * Transforms model messages so no `file` part with an `image/*` mediaType
 * reaches the model. Depending on OCR settings, images are either:
 * - Replaced with their OCR text description, or
 * - Replaced with a static placeholder.
 *
 * This is the single enforcement point: regardless of where the image
 * originated (user upload, history replay, tool output), all paths converge
 * here before `streamText` is called.
 */

import type { ModelMessage } from 'ai';
import { ocrImages, type OcrRequest } from '@/lib/ocr';
import { storage } from '@/store/storage';
import type { OcrSettings, ProviderConfig, ModelConfig } from '@/types';

/** Placeholder when OCR is off or unconfigured. */
const IMAGE_UNSUPPORTED_PLACEHOLDER = '[This image cannot be displayed: the current model does not support vision]';

/** Placeholder when OCR fails entirely (settings misconfigured). */
const IMAGE_OCR_UNAVAILABLE = '[Image recognition unavailable]';

/**
 * Describes an image found in the model messages, with its location so it can
 * be replaced in-place.
 */
interface FoundImage {
  /** Index into the messages array */
  messageIndex: number;
  /** Index into the content array of that message */
  partIndex: number;
  /** Base64 data (decoded from data URL or raw) */
  data: string;
  /** MIME type */
  mimeType: string;
}

/**
 * Extract base64 data from a file part's data field.
 * Handles: { type: 'data', data: string }, { type: 'url', url: URL (data: scheme) }
 */
function extractBase64FromFilePart(part: Record<string, unknown>): { data: string; mimeType: string } | null {
  const mediaType = part.mediaType as string | undefined;
  if (!mediaType?.startsWith('image/')) return null;

  const fileData = part.data as { type?: string; data?: unknown; url?: unknown } | undefined;

  // Shape: { type: 'data', data: base64String }
  if (fileData?.type === 'data' && typeof fileData.data === 'string') {
    return { data: fileData.data, mimeType: mediaType };
  }

  // Shape: { type: 'url', url: URL } with data: scheme
  if (fileData?.type === 'url') {
    const url = fileData.url;
    const urlStr = url instanceof URL ? url.href : typeof url === 'string' ? url : '';
    if (urlStr.startsWith('data:')) {
      const comma = urlStr.indexOf(',');
      if (comma > 0) {
        return { data: urlStr.slice(comma + 1), mimeType: mediaType };
      }
    }
  }

  return null;
}

/**
 * Scan model messages for all image file parts.
 */
function findImages(messages: ModelMessage[]): FoundImage[] {
  const images: FoundImage[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi] as Record<string, unknown>;
      if (part.type !== 'file') continue;

      const extracted = extractBase64FromFilePart(part);
      if (extracted) {
        images.push({ messageIndex: mi, partIndex: pi, ...extracted });
      }
    }
  }

  return images;
}

/**
 * Replace image file parts in model messages with text parts.
 * Returns a new array (does not mutate the input).
 */
function replaceImages(
  messages: ModelMessage[],
  images: FoundImage[],
  replacements: string[],
): ModelMessage[] {
  // Group replacements by message index for efficient batching
  const byMessage = new Map<number, Map<number, string>>();
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    if (!byMessage.has(img.messageIndex)) byMessage.set(img.messageIndex, new Map());
    byMessage.get(img.messageIndex)!.set(img.partIndex, replacements[i]!);
  }

  return messages.map((msg, mi) => {
    const partMap = byMessage.get(mi);
    if (!partMap) return msg;

    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    const newContent = content.map((part, pi) => {
      const replacement = partMap.get(pi);
      if (replacement === undefined) return part;
      return { type: 'text' as const, text: replacement };
    });

    return { ...msg, content: newContent } as ModelMessage;
  });
}

/**
 * Resolve the OCR provider and model from settings + stored providers.
 */
async function resolveOcrModel(
  settings: OcrSettings,
): Promise<{ provider: ProviderConfig; model: ModelConfig } | null> {
  if (!settings.enabled || !settings.providerId || !settings.modelId) return null;
  const providers = await storage.getProviders();
  const provider = providers.find((p) => p.id === settings.providerId);
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === settings.modelId);
  if (!model) return null;
  return { provider, model };
}

/**
 * Project all images out of model messages for a non-vision model.
 *
 * - OCR enabled & configured → images are replaced with their text description.
 * - OCR disabled or unconfigured → images are replaced with a placeholder.
 *
 * This function is idempotent: calling it on already-projected messages does
 * nothing (there are no image parts left to find).
 */
export async function projectImagesForNonVision(
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<ModelMessage[]> {
  const images = findImages(messages);
  if (images.length === 0) return messages;

  // Load OCR settings
  let ocrSettings: OcrSettings;
  try {
    ocrSettings = await storage.getOcrSettings();
  } catch {
    // Storage failure → use placeholder
    const replacements = images.map(() => IMAGE_OCR_UNAVAILABLE);
    return replaceImages(messages, images, replacements);
  }

  if (!ocrSettings.enabled) {
    const replacements = images.map(() => IMAGE_UNSUPPORTED_PLACEHOLDER);
    return replaceImages(messages, images, replacements);
  }

  // Resolve the OCR model
  const resolved = await resolveOcrModel(ocrSettings);
  if (!resolved) {
    const replacements = images.map(() => IMAGE_OCR_UNAVAILABLE);
    return replaceImages(messages, images, replacements);
  }

  // Run OCR
  const requests: OcrRequest[] = images.map((img) => ({
    data: img.data,
    mimeType: img.mimeType,
  }));

  const results = await ocrImages(requests, ocrSettings, resolved.provider, resolved.model, signal);
  const replacements = results.map((r) => `[Image description: ${r.text}]`);
  return replaceImages(messages, images, replacements);
}

/**
 * Build a text-only fallback message for tool-produced images when the model
 * cannot see images. Uses the same OCR pipeline as history images.
 */
export async function buildImageFallbackMessage(
  images: Array<{ data: string; mimeType: string }>,
  signal?: AbortSignal,
): Promise<ModelMessage> {
  let ocrSettings: OcrSettings;
  try {
    ocrSettings = await storage.getOcrSettings();
  } catch {
    return {
      role: 'user',
      content: [{ type: 'text', text: IMAGE_OCR_UNAVAILABLE }],
    };
  }

  if (!ocrSettings.enabled) {
    return {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'The assistant used a browser tool that captured image(s), but the current model does not support vision. The image content is not available.',
        },
      ],
    };
  }

  const resolved = await resolveOcrModel(ocrSettings);
  if (!resolved) {
    return {
      role: 'user',
      content: [{ type: 'text', text: IMAGE_OCR_UNAVAILABLE }],
    };
  }

  const requests: OcrRequest[] = images.map((img) => ({
    data: img.data,
    mimeType: img.mimeType,
  }));

  const results = await ocrImages(requests, ocrSettings, resolved.provider, resolved.model, signal);

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'The assistant used a browser tool that captured the following image(s). ' +
          'Here are their text descriptions:\n\n' +
          results.map((r, i) => `Image ${i + 1}: ${r.text}`).join('\n\n'),
      },
    ],
  };
}

/**
 * Whether OCR is enabled and fully configured (a resolvable provider + model).
 *
 * When true, a non-vision model can still be handed image-producing tools such
 * as `page_screenshot`: their image output is converted to text by the OCR
 * pipeline before it reaches the model (see `buildImageFallbackMessage`).
 */
export async function isOcrAvailable(): Promise<boolean> {
  try {
    const settings = await storage.getOcrSettings();
    if (!settings.enabled) return false;
    return (await resolveOcrModel(settings)) !== null;
  } catch {
    return false;
  }
}

/**
 * Names of built-in tools that require vision capability to be useful.
 * These are filtered out of the tool set for models that cannot consume their
 * image output (neither natively nor via OCR).
 */
export const VISION_ONLY_TOOLS = new Set(['page_screenshot']);

/**
 * Filter tools by the model's effective ability to consume image output.
 *
 * `canUseVisionTools` is true when the model natively supports vision OR when
 * OCR is available to convert image-bearing tool results to text. When false,
 * vision-only tools are removed from the set.
 */
export function filterToolsByVision<T>(
  tools: Record<string, T>,
  canUseVisionTools: boolean,
): Record<string, T> {
  if (canUseVisionTools) return tools;
  const filtered: Record<string, T> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!VISION_ONLY_TOOLS.has(name)) {
      filtered[name] = tool;
    }
  }
  return filtered;
}

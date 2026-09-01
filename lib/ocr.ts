/**
 * OCR execution engine.
 *
 * Calls a user-configured vision model to convert images to text descriptions.
 * Results are cached per-image so repeated appearances (history replay, retry)
 * do not cost additional API calls.
 *
 * This module uses `generateText` directly — no tool loop, no MCP tools — so
 * it cannot recurse into itself.
 */

import { generateText } from 'ai';
import { createProvider } from '@/lib/ai';
import { imageHash, ocrConfigHash, getOcrCache, setOcrCache } from '@/lib/ocr-cache';
import type { OcrSettings, ProviderConfig, ModelConfig } from '@/types';

export interface OcrRequest {
  /** Base64 image data (without the `data:` prefix/header) */
  data: string;
  mimeType: string;
}

export interface OcrResult {
  text: string;
  cached: boolean;
}

/** Maximum concurrent OCR calls to avoid quota exhaustion. */
const MAX_CONCURRENCY = 3;

/**
 * Run OCR on a single image, checking cache first.
 *
 * On failure, returns a fallback string rather than throwing, so the
 * conversation is never blocked by an OCR failure.
 */
export async function ocrImage(
  request: OcrRequest,
  settings: OcrSettings,
  provider: ProviderConfig,
  model: ModelConfig,
  signal?: AbortSignal,
): Promise<OcrResult> {
  const hash = await imageHash(request.data);
  const cfgHash = await ocrConfigHash(settings.providerId, settings.modelId, settings.prompt);

  // Check cache
  const cached = await getOcrCache(hash, cfgHash);
  if (cached !== null) {
    return { text: cached, cached: true };
  }

  // Call the vision model
  try {
    const { model: aiModel } = createProvider(provider, model);
    const { text } = await generateText({
      model: aiModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: settings.prompt },
            {
              type: 'file',
              mediaType: request.mimeType,
              data: { type: 'data' as const, data: request.data },
            },
          ],
        },
      ],
      maxRetries: 1,
      abortSignal: signal,
    });

    const result = text.trim() || '[OCR returned empty result]';
    // Write to cache (fire-and-forget)
    void setOcrCache(hash, result, cfgHash);
    return { text: result, cached: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { text: `[Image recognition failed: ${msg}]`, cached: false };
  }
}

/**
 * Batch OCR with bounded concurrency.
 */
export async function ocrImages(
  requests: OcrRequest[],
  settings: OcrSettings,
  provider: ProviderConfig,
  model: ModelConfig,
  signal?: AbortSignal,
): Promise<OcrResult[]> {
  if (requests.length === 0) return [];

  const results: OcrResult[] = new Array(requests.length);
  let cursor = 0;

  async function worker() {
    while (cursor < requests.length) {
      const idx = cursor++;
      results[idx] = await ocrImage(requests[idx]!, settings, provider, model, signal);
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, requests.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * OCR (image-to-text) settings for non-vision models.
 *
 * When a non-vision model is used, images in the conversation are either:
 * - Converted to text descriptions via a configured vision model (OCR enabled)
 * - Replaced with a placeholder message (OCR disabled)
 */
export interface OcrSettings {
  /** Master switch */
  enabled: boolean;
  /** Provider ID from the user's provider list */
  providerId: string;
  /** Model ID within that provider */
  modelId: string;
  /** Custom prompt sent alongside the image to the vision model */
  prompt: string;
}

export const DEFAULT_OCR_PROMPT =
  'Describe the content of this image in detail, including all text, layout, and visual elements. Output in the same language as any text found in the image.';

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  enabled: false,
  providerId: '',
  modelId: '',
  prompt: DEFAULT_OCR_PROMPT,
};

/**
 * Factory for the `TextAttachment` chips built out of raw text — a drag from a
 * page, a paste past the size threshold, or any other place a blob of content
 * arrives without metadata of its own.
 *
 * Producers used to inline both the id and the preview slicing, so each new
 * entry point re-derived the preview slightly differently. Chips are single-line
 * and truncated, so the preview is normalised here once.
 */

import { v4 as uuidv4 } from 'uuid';
import type { TextAttachment } from '@/types';

/** How many characters of content a chip preview shows. */
const PREVIEW_LENGTH = 50;

/**
 * Reduces content to a single line of prose for the chip.
 *
 * Markup is dropped and runs of whitespace collapsed, because a pasted document
 * is mostly newlines and indentation at its head — without collapsing, the
 * preview of a long code block renders as blank space.
 */
export function attachmentPreview(content: string): string {
  const text = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return (text || content).slice(0, PREVIEW_LENGTH);
}

/**
 * Builds a text attachment from `content`, deriving id and preview.
 *
 * `overrides` carries the semantics the caller knows and this module cannot
 * infer — `kind` for a file reference or page context, `label` for the chip
 * caption (already localised by the caller, as it is displayed verbatim).
 */
export function createTextAttachment(
  content: string,
  mediaType: TextAttachment['mediaType'],
  overrides: Partial<Pick<TextAttachment, 'kind' | 'label'>> = {},
): TextAttachment {
  return {
    id: uuidv4(),
    mediaType,
    content,
    preview: attachmentPreview(content),
    ...overrides,
  };
}

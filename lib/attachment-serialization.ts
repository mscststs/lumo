/**
 * Serialises a {@link TextAttachment} into the text the model actually reads.
 *
 * The UI shows `content`; the model should sometimes see more. A page-context
 * attachment keeps its card clean (plain tabId/title/url) while shipping the
 * `[referenced browser tab]` marker and the tool-calling hint through its
 * `modelText`. This function is the single place that reconciliation happens,
 * so the transcript and the wire never drift.
 *
 * Every attachment is written as a self-describing block: a semantic marker
 * naming what it is, the payload, then a `-----` rule (with a newline on both
 * sides). Because the prompt is a separate part that follows the attachments,
 * each block's trailing rule is what separates attachment from attachment and
 * the last attachment from the prompt — the model never sees body and prompt
 * glued together.
 */

import type { TextAttachment } from '@/types';

/** Rule separating one payload block from the next (and from the prompt). */
const MODEL_DELIMITER = '\n-----\n';

/**
 * Picks the semantic marker that tells the model what the block is.
 * The content itself is the payload for prose; only the marker is added.
 */
function markerFor(attachment: TextAttachment): string {
  if (attachment.kind === 'file-ref') return '[file attachment]';
  if (attachment.mediaType === 'text/html') return '[HTML Content]';
  return '[text attachment]';
}

/**
 * Turns an attachment into the model-facing text.
 *
 * - An explicit `modelText` wins — used by page-context attachments that carry
 *   the `[referenced browser tab]` marker and a tool hint the UI card should
 *   not show.
 * - Everything else gets a semantic marker naming its kind, then its payload.
 * - A trailing `-----` rule closes the block, separating it from the next
 *   attachment and from the prompt (which is a separate part that follows).
 */
export function serializeAttachmentForModel(attachment: TextAttachment): string {
  const body =
    attachment.modelText !== undefined
      ? attachment.modelText
      : `${markerFor(attachment)}\n${attachment.content}`;
  return `${body}${MODEL_DELIMITER}`;
}
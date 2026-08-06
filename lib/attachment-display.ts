/**
 * Display helpers shared by the attachment chip in the input box
 * (`ChatInput`) and the attachment card in the transcript (`MessageBubble`).
 *
 * The label fallback chain lived duplicated in both components, which meant
 * every new `TextAttachment.kind` had to be taught to two places and could
 * silently render as "Text" in one of them. It lives here instead.
 */

import type { TextAttachment } from '@/types';

/** Minimal shape of the i18next `t` function this module needs. */
type Translate = (key: string) => string;

/**
 * Resolves the label shown on an attachment.
 *
 * Precedence: an explicit `label` set by the producer wins, then the semantic
 * `kind`, then the media type. HTML is labelled literally rather than via i18n
 * because it is a format name, not prose.
 */
export function attachmentLabel(attachment: TextAttachment, t: Translate): string {
  if (attachment.label) return attachment.label;

  switch (attachment.kind) {
    case 'file-ref':
      return t('sidebar.files.file');
    case 'page-context':
      return t('sidebar.pageContextAttachment');
    default:
      return attachment.mediaType === 'text/html' ? 'HTML' : t('sidebar.textAttachment');
  }
}

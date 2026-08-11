/**
 * The drag payload for a stored file, written identically wherever a file can be
 * picked up — the conversation files panel, a transcript chip, and the options
 * page file manager.
 *
 * Each of those sites used to inline the same two `setData` calls, so the
 * `[filename: name]` wording of the plain-text fallback (the form the chat
 * the model both read a reference in) was re-spelled per call site and drifted.
 * Centralising it also keeps the fallback in step with `parseFileRefContent`,
 * which recovers the name when a chip is dragged back out.
 */

import { LUMO_FILE_REF_MIME } from '@/lib/constants';

/** Renders a file reference in the textual form used inside message content. */
export function fileRefContent(fileName: string): string {
  return `[filename: ${fileName}]`;
}

/** Recovers the file name from `fileRefContent` output; null if not a reference. */
export function parseFileRefContent(content: string): string | null {
  return /^\[filename:\s*(.+)\]$/.exec(content)?.[1] ?? null;
}

/**
 * Writes a file reference into a drag payload.
 *
 * The custom MIME type is what drop targets act on; the plain-text fallback is
 * for targets that know nothing about Lumo (another tab, an editor). Both
 * survive a cross-document drag, which is what lets a row in the options page
 * be dropped into the side panel.
 */
export function setFileRefDragData(dataTransfer: DataTransfer, fileName: string): void {
  dataTransfer.setData(LUMO_FILE_REF_MIME, fileName);
  dataTransfer.setData('text/plain', fileRefContent(fileName));
  dataTransfer.effectAllowed = 'copy';
}

/**
 * The drag payloads written by reference chips — a stored file, and a skill.
 *
 * Each call site used to inline the same `setData` calls, so the `[filename: name]`
 * wording of the plain-text fallback (the form the chat and the model both read a
 * reference in) was re-spelled per site and drifted. Centralising it also keeps
 * the fallback in step with `parseFileRefContent`, which recovers the name when a
 * chip is dragged back out.
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
 * The plain-text form of a skill reference — the drag fallback for a
 * `kind: 'skill'` chip, whose internal payload carries the instruction block.
 *
 * Without it, dropping a skill chip on an editor (or a tab that knows nothing
 * about Lumo) would paste an entire skill's instructions into it, which is the
 * same reason a file reference travels as `[filename: …]` rather than as the
 * file's contents.
 */
export function skillRefContent(name: string): string {
  return `[skill: ${name}]`;
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

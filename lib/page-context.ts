/**
 * Page context attachments.
 *
 * A quick action fired from the right-click menu carries the identity of the
 * page it came from. Without it the model sees "translate this page" with no
 * idea which tab that is — and, worse, would guess a `tabId` when calling
 * `page_read` / `page_snapshot`, silently operating on whichever tab happens to
 * be active by the time the request lands.
 *
 * So every quick action ships a text attachment holding the tab id, title and
 * URL. `tabId` is the load-bearing field: it is the exact value the `page_*` and
 * `browser_*` MCP tools take, which turns the attachment from a display label
 * into an actionable handle.
 *
 * The rendered body is plain text rather than JSON so it reads naturally in the
 * transcript and stays cheap in tokens.
 */

import type { TextAttachment } from '@/types';

export interface PageContext {
  /** Chrome tab id — pass this straight to the `page_*` / `browser_*` tools. */
  tabId: number;
  title: string;
  url: string;
}

/** Marker prefix so the model can spot the block. Never shown in the UI. */
const PAGE_CONTEXT_HEADER = 'referenced browser tab';

/**
 * Renders a page context as the plain identity block stored on the attachment
 * and shown in the transcript's attachment card. Deliberately free of the
 * `[referenced browser tab]` marker and the tool-calling hint — those are for
 * the model only and are appended at serialisation time via
 * {@link formatPageContextForModel}, so the UI card stays clean prose.
 */
export function formatPageContext(context: PageContext): string {
  return [
    `tabId: ${context.tabId}`,
    `title: ${context.title}`,
    `url: ${context.url}`,
  ].join('\n');
}

/**
 * Renders a page context as the text the model receives, with the semantic
 * marker and the tool-calling convention prepended/appended.
 *
 * The trailing hint is what makes `tabId` usable: stating the calling
 * convention inline is far more reliable than hoping the model infers that the
 * number matches the `tabId` parameter of the page tools.
 */
export function formatPageContextForModel(context: PageContext): string {
  return [
    `[${PAGE_CONTEXT_HEADER}]`,
    formatPageContext(context),
    '',
    `Use tabId ${context.tabId} when calling page_* or browser_* tools so they act on this exact tab.`,
  ].join('\n');
}

/**
 * Builds the attachment chip shown in the input box and the transcript.
 *
 * `content` stays clean for the UI card; `modelText` carries the marker and
 * tool-calling hint that only the model should read (see
 * {@link serializeAttachmentForModel}).
 *
 * @param id Caller-supplied id so the caller owns uuid generation (this module
 *   stays pure and testable).
 * @param label Localised label for the chip, e.g. "Page".
 */
export function buildPageContextAttachment(
  id: string,
  context: PageContext,
  label: string,
): TextAttachment {
  return {
    id,
    kind: 'page-context',
    mediaType: 'text/plain',
    content: formatPageContext(context),
    modelText: formatPageContextForModel(context),
    // The title is the only part worth surfacing in a narrow chip; the URL is
    // usually too long to read at sidebar width and is one click away in the
    // expanded card.
    preview: context.title || context.url,
    label,
  };
}

/** Whether an attachment is a page context block. */
export function isPageContextAttachment(attachment: TextAttachment): boolean {
  return attachment.kind === 'page-context';
}

/**
 * Shared constants used across multiple modules.
 */

/**
 * Custom MIME type used in drag-and-drop dataTransfer to identify internal
 * file reference drags (from ConversationFiles panel). This allows the global
 * drag overlay to distinguish internal drags from external drags.
 */
export const LUMO_FILE_REF_MIME = 'application/x-lumo-file-ref';

/**
 * Custom MIME type used in drag-and-drop dataTransfer to identify internal
 * image drags (e.g. dragging an image attachment from chat history into the
 * input box). Carries the image data URL.
 */
export const LUMO_IMAGE_DRAG_MIME = 'application/x-lumo-image';

/**
 * Custom MIME type used for internal text-attachment drags within the sidebar.
 *
 * Carries the *entire* `TextAttachment` serialised as JSON rather than a
 * decomposed fragment. The alternative — mapping each attachment kind to its
 * own custom MIME type and drop-handler branch, as image/file drags do — forces
 * every new `TextAttachment.kind` to be taught to both the drag source and the
 * drop target, and silently degrades anything untaught to plain text. Serialising
 * the full attachment means `kind`, `label`, `mediaType`, `preview` and `content`
 * all round-trip exactly, so a `page-context` chip dragged back into the input
 * box is re-added as a page rather than dissolving into generic text.
 */
export const LUMO_ATTACHMENT_MIME = 'application/x-lumo-attachment';

/**
 * Marker set on a drag that starts from an attachment chip in an input box
 * (`ChatInput`).
 *
 * Drop targets use it to decide the drop semantics: a chip drag relocates the
 * attachment (dropEffect `'move'`, so the source chip is removed on dragend),
 * whereas a transcript card or file-list row drag is a copy (the source stays).
 * Each source honours this by setting `effectAllowed` to match, so the two
 * never disagree with the browser's compatibility check.
 */
export const LUMO_INPUT_CHIP_MIME = 'application/x-lumo-input-chip';

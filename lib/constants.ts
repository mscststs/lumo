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

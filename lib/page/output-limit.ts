import type { PageOutputLimit, PageOutputLimitMeta } from './messages';

/**
 * Ceiling for a single page-read tool call.
 *
 * Existing tools are unbounded: `page_get_text` / `page_get_html` return the
 * whole page, and `MAX_TEXT_LENGTH = 2000` in `lib/tool-output.ts` only
 * truncates the *UI*, never the model payload. One call can therefore blow the
 * context window.
 */
export const DEFAULT_MAX_CHARS = 20_000;
export const HARD_MAX_CHARS = 120_000;

export function applyOutputLimit(
  text: string,
  limit: PageOutputLimit = {},
): { text: string; limit: PageOutputLimitMeta } {
  const rawOffset = limit.offset;
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset as number) : 0);
  const rawMax = limit.maxChars;
  const maxChars = Math.min(
    Math.max(1, Number.isFinite(rawMax) ? Math.floor(rawMax as number) : DEFAULT_MAX_CHARS),
    HARD_MAX_CHARS,
  );
  const slice = text.slice(offset, offset + maxChars);
  return {
    text: slice,
    limit: {
      totalChars: text.length,
      returnedChars: slice.length,
      offset,
      // Report the truth so the model can page instead of silently believing
      // it read everything — the failure mode of the current slice(0, 5000).
      truncated: offset + slice.length < text.length,
    },
  };
}

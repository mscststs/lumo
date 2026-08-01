/**
 * Tool output normalization for the sidebar.
 *
 * Built-in tools return wildly different shapes: plain objects, arrays, huge
 * HTML/text dumps (`page_get_html`, `debug_get_accessibility_tree`) and large
 * base64 screenshots (`page_screenshot`, `debug_full_page_screenshot`).
 * Rendering those raw would freeze the panel, so outputs are classified and
 * capped before display.
 */

/** Max characters of JSON/text shown before truncation. */
const MAX_TEXT_LENGTH = 2000;

export type NormalizedToolOutput =
  | { kind: 'empty' }
  | { kind: 'image'; url: string; caption?: string }
  | { kind: 'error'; message: string }
  | { kind: 'text'; text: string; truncated: boolean; totalLength: number };

/** Detect a data-URL or http(s) image string. */
function asImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('data:image/')) return value;
  return undefined;
}

/** Pull `{ dataUrl }` out of a screenshot-style result object. */
function findImageField(value: object): string | undefined {
  for (const key of ['dataUrl', 'screenshot', 'image'] as const) {
    const candidate = asImageUrl((value as Record<string, unknown>)[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

export function normalizeToolOutput(output: unknown): NormalizedToolOutput {
  if (output == null) return { kind: 'empty' };

  const directImage = asImageUrl(output);
  if (directImage) return { kind: 'image', url: directImage };

  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;

    // Several tools signal failure by returning `{ error }` instead of throwing,
    // which never becomes an `output-error` state — surface it as an error anyway.
    if (typeof record.error === 'string' && Object.keys(record).length <= 2) {
      return { kind: 'error', message: record.error };
    }

    const image = findImageField(record);
    if (image) {
      const rest = Object.fromEntries(
        Object.entries(record).filter(
          ([key, value]) => value !== image && key !== 'success',
        ),
      );
      const caption = Object.keys(rest).length > 0 ? safeStringify(rest) : undefined;
      return { kind: 'image', url: image, ...(caption ? { caption } : {}) };
    }
  }

  const text = typeof output === 'string' ? output : safeStringify(output);
  const totalLength = text.length;

  if (totalLength > MAX_TEXT_LENGTH) {
    return {
      kind: 'text',
      text: text.slice(0, MAX_TEXT_LENGTH),
      truncated: true,
      totalLength,
    };
  }

  return { kind: 'text', text, truncated: false, totalLength };
}

/** JSON stringify that survives circular refs and bigints. */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Compact one-line preview of tool input, shown collapsed in the header. */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);

  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string'
          ? value.length > 40
            ? `${value.slice(0, 40)}…`
            : value
          : Array.isArray(value)
            ? `[${value.length}]`
            : typeof value === 'object'
              ? '{…}'
              : String(value);
      return `${key}: ${rendered}`;
    })
    .join(', ');
}

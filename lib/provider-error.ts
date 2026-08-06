import { APICallError, getErrorMessage } from '@ai-sdk/provider';

/**
 * Structured failure signals recovered from a provider payload.
 *
 * These are deliberately kept off `Error.name`: that field already carries
 * meaning (`AbortError` / `TimeoutError` decide whether a stream was cancelled),
 * so writing a provider code into it could make a real API failure look like a
 * user-initiated abort.
 */
export interface ProviderErrorInfo {
  /** Provider error code, e.g. `insufficient_quota`, `server_error`. */
  code?: string;
  /** HTTP status when the provider or SDK reported one. */
  statusCode?: number;
}

/**
 * An `Error` that also carries the provider's own failure signals.
 *
 * Classification prefers these over substring matching on the message, which is
 * brittle: the quota failure that motivated this class has `code: 'server_error'`
 * and mentions `402` only inside prose.
 */
export class ProviderError extends Error implements ProviderErrorInfo {
  readonly code?: string;
  readonly statusCode?: number;

  constructor(
    message: string,
    { code, statusCode, cause }: ProviderErrorInfo & { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

/** Read the structured signals off any error, when present. */
export function providerErrorInfo(error: unknown): ProviderErrorInfo {
  if (error instanceof ProviderError) {
    return { code: error.code, statusCode: error.statusCode };
  }
  if (APICallError.isInstance(error)) {
    return {
      code: extract(error.data)?.code,
      statusCode: error.statusCode,
    };
  }
  return {};
}

/**
 * Turn anything a provider stream can surface into an `Error`.
 *
 * Providers do not restrict stream errors to `Error` instances — the `error`
 * field on an error stream part is typed `unknown`. The OpenAI Responses
 * provider, for example, enqueues a plain object frame when the server ends a
 * stream with `response.failed`:
 *
 * ```
 * { type: 'response.failed', sequence_number, response: { error: { code, message } } }
 * ```
 *
 * The provider does convert that frame into an `APICallError`, but only while
 * peeking for an *early* failure: after `response.in_progress` each read is
 * raced against a short grace window, so a late failure escapes as a raw frame.
 *
 * `String(frame)` on such a frame yields `"[object Object]"`, and the SDK's own
 * `getErrorMessage` falls back to `JSON.stringify`, which keeps the payload but
 * buries the readable reason inside the echoed request. This unwraps the shapes
 * we know about first and only then falls back to the SDK helper, so no
 * information is ever lost.
 */
export function toError(value: unknown): Error {
  // Checked before the generic `Error` branch: `APICallError` *is* an Error, but
  // its own message is often a generic wrapper ("stream failed before any
  // output was generated") while `data` holds the server's actual reason.
  if (APICallError.isInstance(value)) {
    const nested = extract(value.data);
    if (nested != null && nested.message !== value.message) {
      return new ProviderError(nested.message, {
        code: nested.code,
        statusCode: nested.statusCode ?? value.statusCode,
        cause: value,
      });
    }
    return value;
  }

  if (value instanceof Error) return value;

  const extracted = extract(value);
  if (extracted != null) {
    return new ProviderError(extracted.message, {
      code: extracted.code,
      statusCode: extracted.statusCode,
      // Preserve the original frame for debugging.
      cause: value,
    });
  }

  // `getErrorMessage` handles strings, Errors and JSON-serializable values, and
  // never returns "[object Object]".
  return new Error(getErrorMessage(value));
}

interface ExtractedError extends ProviderErrorInfo {
  message: string;
}

/**
 * Pull the readable reason and failure signals out of a provider payload.
 *
 * Returns `undefined` when no known shape matches, so callers fall back to a
 * generic serialization rather than inventing a message.
 */
function extract(value: unknown): ExtractedError | undefined {
  const record = asRecord(value);
  if (record == null) return undefined;

  // OpenAI Responses: `{ type: 'response.failed', response: { error } }`
  const response = asRecord(record.response);
  if (response != null) {
    const fromResponse = readErrorObject(response.error);
    if (fromResponse != null) return fromResponse;

    // A stream can also stop without an error object, carrying only a reason.
    const reason = asRecord(response.incomplete_details)?.reason;
    if (typeof reason === 'string' && reason.length > 0) {
      return { message: reason, code: reason };
    }
  }

  // Chat Completions and most gateways: `{ error: { message, code } }`
  const fromError = readErrorObject(record.error);
  if (fromError != null) return fromError;

  // Some gateways return `{ message, code }` at the top level.
  return readErrorObject(record);
}

/** Read a `{ message, code, status }`-shaped object, if it is one. */
function readErrorObject(value: unknown): ExtractedError | undefined {
  const record = asRecord(value);
  if (record == null) return undefined;

  const { message } = record;
  if (typeof message !== 'string' || message.length === 0) return undefined;

  return {
    message,
    code: readCode(record.code ?? record.type),
    statusCode: readStatus(record.status ?? record.status_code ?? record.statusCode),
  };
}

function readCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Accept a status only when it is a plausible HTTP error code. */
function readStatus(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{3}$/.test(value)
        ? Number(value)
        : undefined;
  return numeric != null && numeric >= 400 && numeric <= 599 ? numeric : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value != null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** User-facing failure categories, each mapped to its own localized copy. */
export type ChatErrorCategory =
  | 'network'
  | 'auth'
  | 'quota'
  | 'rateLimit'
  | 'server'
  | 'timeout'
  | 'storage'
  | 'unknown';

/**
 * Detect a browser-storage failure.
 *
 * Checked before every provider heuristic because the strings overlap
 * dangerously: Chrome's `Resource::kQuotaBytes quota exceeded` contains "quota"
 * and would otherwise be read as a depleted provider account, sending the user
 * off to top up an account that is perfectly fine.
 */
function isStorageFailure(error: Error): boolean {
  // `QuotaExceededError` is the DOMException name IndexedDB raises when the
  // origin's allowance is gone; the `kQuotaBytes` string is what
  // `chrome.storage` throws.
  if (error.name === 'QuotaExceededError') return true;

  const msg = error.message.toLowerCase();
  return (
    msg.includes('kquotabytes') ||
    msg.includes('quota_bytes') ||
    msg.includes('quotaexceedederror') ||
    msg.includes('indexeddb') ||
    msg.includes('chat db') ||
    msg.includes('transaction aborted')
  );
}

/**
 * Classify a failure for display and retry decisions.
 *
 * Structured signals win over the message text. Substring matching is a
 * last resort because provider prose is unstable and misleading — the quota
 * failure that motivated this carries `code: 'server_error'` and mentions `402`
 * only inside a sentence, so matching alone read it as a transient server error.
 */
export function categorizeError(error: Error): ChatErrorCategory {
  // Before anything provider-shaped: a storage fault has no provider code or
  // status, and its message would be misread by the text heuristics below.
  if (isStorageFailure(error)) return 'storage';

  const { code, statusCode } = providerErrorInfo(error);

  const fromCode = categorizeByCode(code);
  if (fromCode != null) return fromCode;

  const fromStatus = categorizeByStatus(statusCode);
  if (fromStatus != null) return fromStatus;

  return categorizeByMessage(error.message);
}

/** Provider error codes are the most reliable signal when present. */
function categorizeByCode(code: string | undefined): ChatErrorCategory | undefined {
  if (code == null) return undefined;
  const normalized = code.toLowerCase();

  // Checked before rate limiting: OpenAI reports a depleted account as a 429
  // with `insufficient_quota`, but unlike a real rate limit it never recovers.
  if (
    normalized.includes('insufficient_quota') ||
    normalized.includes('billing') ||
    normalized.includes('payment')
  ) {
    return 'quota';
  }
  if (
    normalized.includes('invalid_api_key') ||
    normalized.includes('authentication') ||
    normalized.includes('unauthorized') ||
    normalized.includes('permission')
  ) {
    return 'auth';
  }
  if (normalized.includes('rate_limit') || normalized.includes('too_many_requests')) {
    return 'rateLimit';
  }
  if (normalized.includes('timeout') || normalized.includes('deadline')) {
    return 'timeout';
  }
  if (normalized.includes('overload')) return 'server';

  // `server_error` is deliberately not mapped here: providers use it as a
  // catch-all, including for billing failures, so the message and status carry
  // more information than the code does.
  return undefined;
}

function categorizeByStatus(status: number | undefined): ChatErrorCategory | undefined {
  if (status == null) return undefined;
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return 'rateLimit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return undefined;
}

function categorizeByMessage(message: string): ChatErrorCategory {
  const msg = message.toLowerCase();

  if (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('net::') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound')
  ) {
    return 'network';
  }

  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication')
  ) {
    return 'auth';
  }

  // Before rate limiting, for the same reason as in `categorizeByCode`.
  if (
    msg.includes('402') ||
    msg.includes('insufficient_quota') ||
    msg.includes('insufficient credit') ||
    msg.includes('depleted') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('billing') ||
    msg.includes('payment required') ||
    msg.includes('purchase pre-paid credits')
  ) {
    return 'quota';
  }

  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota')
  ) {
    return 'rateLimit';
  }

  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline')) {
    return 'timeout';
  }

  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('internal server error') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway') ||
    msg.includes('overloaded')
  ) {
    return 'server';
  }

  return 'unknown';
}

/**
 * Whether a category is safe to auto-retry.
 *
 * Auth and quota failures are deterministic: retrying burns the backoff delay
 * and hits the same wall, so they surface immediately instead. Storage failures
 * are the same — the disk will not have more room a second later, and the reply
 * itself already succeeded, so a retry would only re-run the model call.
 */
export function isRetryableCategory(category: ChatErrorCategory): boolean {
  return category !== 'auth' && category !== 'quota' && category !== 'storage';
}

import { describe, it, expect } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import { toError, providerErrorInfo, ProviderError } from '@/lib/provider-error';
import { classifyError, isRetryableError } from '@/components/chat/ChatError';

const QUOTA_MESSAGE =
  '402 "You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage."';

/**
 * The frame `@ai-sdk/openai` enqueues when a Responses stream ends with
 * `response.failed` after generation already started. It is a plain object, not
 * an Error, and the real payload also echoes the entire request (tools, schemas)
 * which is why blind serialization is unusable in the UI.
 */
function responseFailedFrame(message = QUOTA_MESSAGE, code = 'server_error') {
  return {
    type: 'response.failed',
    sequence_number: 2,
    response: {
      error: { code, message },
      incomplete_details: null,
      service_tier: null,
    },
  };
}

describe('toError', () => {
  it('returns Error instances unchanged', () => {
    const original = new Error('boom');
    expect(toError(original)).toBe(original);
  });

  it('extracts the reason from an OpenAI response.failed frame', () => {
    const error = toError(responseFailedFrame());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(QUOTA_MESSAGE);
    // The regression this guards: String(frame) collapses to "[object Object]".
    expect(error.message).not.toContain('[object Object]');
  });

  it('keeps the original frame as `cause` for debugging', () => {
    const frame = responseFailedFrame();
    expect(toError(frame).cause).toBe(frame);
  });

  it('exposes the provider error code as a structured field', () => {
    const error = toError(responseFailedFrame(QUOTA_MESSAGE, 'insufficient_quota'));
    expect(providerErrorInfo(error).code).toBe('insufficient_quota');
  });

  it('never writes the provider code into `name`', () => {
    // `name` is load-bearing: `isAbort` treats AbortError/TimeoutError as a
    // user-initiated stop. A gateway returning `code: "TimeoutError"` must not
    // be able to make a real API failure look like an abort.
    const error = toError(responseFailedFrame('upstream gave up', 'TimeoutError'));
    expect(error.name).not.toBe('TimeoutError');
    expect(error.name).toBe('ProviderError');
    expect(providerErrorInfo(error).code).toBe('TimeoutError');
  });

  it('falls back to incomplete_details when no error object is present', () => {
    const error = toError({
      type: 'response.failed',
      response: { error: null, incomplete_details: { reason: 'content_filter' } },
    });
    expect(error.message).toBe('content_filter');
  });

  it('handles the chat-completions `{ error: { message } }` shape', () => {
    const error = toError({ error: { message: 'Model overloaded', code: 503 } });
    expect(error.message).toBe('Model overloaded');
    expect(providerErrorInfo(error).code).toBe('503');
  });

  it('handles a bare `{ message }` payload from a gateway', () => {
    expect(toError({ message: 'upstream exploded' }).message).toBe('upstream exploded');
  });

  it('prefers the nested server reason carried by an APICallError', () => {
    const apiError = new APICallError({
      message: 'OpenAI stream failed before any output was generated',
      url: 'https://example.test/v1/responses',
      requestBodyValues: {},
      data: responseFailedFrame(),
    });
    // The generic wrapper message is useless; the frame explains the failure.
    expect(toError(apiError).message).toBe(QUOTA_MESSAGE);
  });

  it('keeps an APICallError message when it carries no richer data', () => {
    const apiError = new APICallError({
      message: 'Bad gateway',
      url: 'https://example.test/v1/responses',
      requestBodyValues: {},
    });
    expect(toError(apiError).message).toBe('Bad gateway');
  });

  it('never produces "[object Object]" for unknown shapes', () => {
    for (const value of [{ weird: true }, [1, 2, 3], 42, null, undefined]) {
      expect(toError(value).message).not.toContain('[object Object]');
    }
  });

  it('passes strings through', () => {
    expect(toError('plain failure').message).toBe('plain failure');
  });
});

describe('classifyError', () => {
  it('classifies depleted credits as quota, not server or unknown', () => {
    // Regression: the message contains "server_error" as its code and no
    // rate-limit keyword, so it used to fall through to `unknown` and be
    // retried three times despite being permanent.
    const info = classifyError(new Error(QUOTA_MESSAGE));
    expect(info.category).toBe('quota');
  });

  it('treats OpenAI insufficient_quota (sent as 429) as quota, not rate limit', () => {
    const info = classifyError(
      new Error('429 insufficient_quota: You exceeded your current quota.'),
    );
    expect(info.category).toBe('quota');
  });

  it('still classifies genuine rate limits as rateLimit', () => {
    expect(classifyError(new Error('429 Too Many Requests')).category).toBe('rateLimit');
    expect(classifyError(new Error('Rate limit reached')).category).toBe('rateLimit');
  });

  it('keeps the existing categories intact', () => {
    expect(classifyError(new Error('Failed to fetch')).category).toBe('network');
    expect(classifyError(new Error('401 Unauthorized')).category).toBe('auth');
    expect(classifyError(new Error('503 Service Unavailable')).category).toBe('server');
    expect(classifyError(new Error('Request timed out')).category).toBe('timeout');
    expect(classifyError(new Error('something odd')).category).toBe('unknown');
  });

  it('preserves the raw message for display', () => {
    expect(classifyError(new Error(QUOTA_MESSAGE)).message).toBe(QUOTA_MESSAGE);
  });
});

describe('classifyError via structured signals', () => {
  it('prefers an HTTP status over misleading message prose', () => {
    // Message says "server error", status says the account is unpaid.
    const error = new ProviderError('The server returned an error', {
      statusCode: 402,
      code: 'server_error',
    });
    expect(classifyError(error).category).toBe('quota');
  });

  it('prefers a provider code over a misleading status', () => {
    // OpenAI reports a depleted account as 429, which reads as a rate limit.
    const error = new ProviderError('You exceeded your quota', {
      statusCode: 429,
      code: 'insufficient_quota',
    });
    expect(classifyError(error).category).toBe('quota');
  });

  it('classifies a genuine 429 without a quota code as a rate limit', () => {
    const error = new ProviderError('Slow down', { statusCode: 429, code: 'rate_limit' });
    expect(classifyError(error).category).toBe('rateLimit');
  });

  it('maps auth statuses without needing keywords', () => {
    expect(
      classifyError(new ProviderError('nope', { statusCode: 401 })).category,
    ).toBe('auth');
    expect(
      classifyError(new ProviderError('nope', { statusCode: 403 })).category,
    ).toBe('auth');
  });

  it('maps 5xx statuses to server and gateway timeouts to timeout', () => {
    expect(classifyError(new ProviderError('x', { statusCode: 500 })).category).toBe('server');
    expect(classifyError(new ProviderError('x', { statusCode: 503 })).category).toBe('server');
    expect(classifyError(new ProviderError('x', { statusCode: 504 })).category).toBe('timeout');
    expect(classifyError(new ProviderError('x', { statusCode: 408 })).category).toBe('timeout');
  });

  it('does not let the catch-all `server_error` code override the message', () => {
    // Providers use `server_error` for billing failures too, so the code alone
    // must not win here — the message has to be consulted.
    const error = new ProviderError(QUOTA_MESSAGE, { code: 'server_error' });
    expect(classifyError(error).category).toBe('quota');
  });

  it('reads signals off an APICallError status', () => {
    const apiError = new APICallError({
      message: 'Payment required',
      url: 'https://example.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 402,
    });
    expect(classifyError(apiError).category).toBe('quota');
  });

  it('falls back to message matching when no signals exist', () => {
    expect(classifyError(new Error('Failed to fetch')).category).toBe('network');
  });
});

describe('providerErrorInfo', () => {
  it('returns empty info for a plain Error', () => {
    expect(providerErrorInfo(new Error('x'))).toEqual({});
  });

  it('reads status from an APICallError', () => {
    const apiError = new APICallError({
      message: 'boom',
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode: 500,
    });
    expect(providerErrorInfo(apiError).statusCode).toBe(500);
  });
});

describe('isRetryableError', () => {
  it('does not auto-retry deterministic failures', () => {
    expect(isRetryableError('auth')).toBe(false);
    expect(isRetryableError('quota')).toBe(false);
    // The disk will not have more room a second later, and the reply itself
    // already succeeded — retrying would only re-run the model call.
    expect(isRetryableError('storage')).toBe(false);
  });

  it('auto-retries transient failures', () => {
    for (const category of ['network', 'rateLimit', 'server', 'timeout', 'unknown'] as const) {
      expect(isRetryableError(category)).toBe(true);
    }
  });
});

describe('classifyError for browser storage failures', () => {
  it('does not mistake a Chrome storage quota error for a depleted account', () => {
    // Regression: this message contains "quota", so the provider heuristics read
    // it as `quota` and told the user to top up an account that was fine. The
    // real fault is local storage being full.
    const info = classifyError(new Error('Resource::kQuotaBytes quota exceeded'));
    expect(info.category).toBe('storage');
  });

  it('recognises the IndexedDB quota DOMException by name', () => {
    // The message is localised by the browser, so the name is the reliable signal.
    const error = new Error('The current transaction exceeded its quota limitations.');
    error.name = 'QuotaExceededError';
    expect(classifyError(error).category).toBe('storage');
  });

  it('recognises an aborted database transaction', () => {
    expect(classifyError(new Error('Chat DB transaction aborted')).category).toBe('storage');
  });

  it('does not steal genuine provider quota failures', () => {
    // The provider path must still win for account-level exhaustion.
    expect(classifyError(new Error(QUOTA_MESSAGE)).category).toBe('quota');
    expect(
      classifyError(new Error('429 insufficient_quota: You exceeded your current quota.')).category,
    ).toBe('quota');
  });
});

describe('end-to-end: a late response.failed frame', () => {
  it('reaches the user as a quota error with a readable message', () => {
    // The full path: provider frame -> toError -> classifyError.
    const info = classifyError(toError(responseFailedFrame()));
    expect(info.category).toBe('quota');
    expect(info.message).toBe(QUOTA_MESSAGE);
    expect(isRetryableError(info.category)).toBe(false);
  });
});

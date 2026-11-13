import type { KeyboardEvent } from 'react';

/**
 * IME-aware Enter handling for "commit on Enter" inputs.
 *
 * An IME (Chinese, Japanese, Korean, …) uses `Enter` to confirm the candidate
 * it is currently composing. A handler that focuses on `key === 'Enter'` alone
 * therefore fires mid-composition: the committed value gets submitted twice, or
 * a half-converted value is written back into storage before the candidate was
 * accepted.
 *
 * `isComposing` is the standard signal, but Safari has shipped an event-ordering
 * bug (WebKit #165004) where `compositionend` reaches script handlers before the
 * confirming `keydown`, leaving `isComposing` already `false` by the time the
 * handler runs. Browsers report `keyCode === 229` (VK_PROCESSKEY) on that
 * keystroke, which is the documented fallback and is why the deprecated property
 * is still read here.
 *
 * The `keyCode` check sits *inside* the `Enter` gate at the call sites, so a
 * mobile virtual keyboard that reports 229 for ordinary characters cannot
 * accidentally swallow input.
 */
export function isImeConfirming(
  event: KeyboardEvent<Element> | globalThis.KeyboardEvent,
): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing === true || native.keyCode === 229;
}

/**
 * Enter-to-commit handler for a single-line control.
 *
 * Returns `true` when it handled the event, so a caller can chain behaviour.
 * Non-Enter keys and IME-confirming keystrokes are left untouched — the latter
 * including `preventDefault`, because the browser must still be allowed to
 * accept the candidate.
 */
export function commitOnEnter(
  event: KeyboardEvent<Element>,
  commit: () => void,
): boolean {
  if (event.key !== 'Enter' || isImeConfirming(event)) return false;
  event.preventDefault();
  commit();
  return true;
}

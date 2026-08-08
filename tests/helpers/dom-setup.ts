/** jsdom has no ResizeObserver; `use-stick-to-bottom` attaches one on mount. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/**
 * jsdom implements pointer *events* but not the pointer *capture* API.
 *
 * Radix's Select trigger calls `hasPointerCapture` straight from its
 * `pointerdown` handler, so any test that dispatches a real `PointerEvent` at a
 * header — which is now the panel drag surface — throws from inside Radix rather
 * than from the code under test. Stubbing here rather than per test keeps that
 * failure from reappearing every time a component test grows a pointer gesture.
 */
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= function hasPointerCapture() {
    return false;
  };
  Element.prototype.setPointerCapture ??= function setPointerCapture() {};
  Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
}

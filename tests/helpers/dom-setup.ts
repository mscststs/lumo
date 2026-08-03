/** jsdom has no ResizeObserver; `use-stick-to-bottom` attaches one on mount. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

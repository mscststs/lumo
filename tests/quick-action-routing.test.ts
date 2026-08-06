import { describe, it, expect } from 'vitest';
import { routeQuickAction, type PanelRoutingState } from '@/lib/quick-action-routing';

/** Terse panel builder: `p(id, streaming, hasContent)`. */
const p = (
  panelId: number,
  isStreaming: boolean,
  hasContent: boolean,
): PanelRoutingState => ({ panelId, isStreaming, hasContent });

describe('routeQuickAction', () => {
  it('sends on the only panel when it is idle and empty', () => {
    expect(routeQuickAction([p(0, false, false)], true)).toEqual({
      panelId: 0,
      delivery: 'send',
    });
  });

  it('prefills instead of sending when the action carries no prompt', () => {
    // An action with nothing to ask must never fire a request, even on a panel
    // that could accept one.
    expect(routeQuickAction([p(0, false, false)], false)).toEqual({
      panelId: 0,
      delivery: 'prefill',
    });
  });

  it('prefers the rightmost sendable panel', () => {
    // Panel 0 is rightmost and sendable, so it wins over panel 1.
    const route = routeQuickAction([p(1, false, false), p(0, false, false)], true);
    expect(route).toEqual({ panelId: 0, delivery: 'send' });
  });

  it('skips a busy panel to send on an idle one', () => {
    const route = routeQuickAction([p(0, true, false), p(1, false, false)], true);
    expect(route).toEqual({ panelId: 1, delivery: 'send' });
  });

  it('skips a panel holding a draft to send on an empty one', () => {
    const route = routeQuickAction([p(0, false, true), p(1, false, false)], true);
    expect(route).toEqual({ panelId: 1, delivery: 'send' });
  });

  it('prefills the empty panel when every panel is streaming', () => {
    // Nothing can be sent, so the empty input is the courteous landing spot even
    // though that panel is mid-stream.
    const route = routeQuickAction([p(0, true, true), p(1, true, false)], true);
    expect(route).toEqual({ panelId: 1, delivery: 'prefill' });
  });

  it('prefills an empty input over an idle panel that holds a draft', () => {
    // Panel 0 is idle but has a draft; panel 1 is streaming but empty. Landing on
    // the empty one avoids merging two texts in one box.
    const route = routeQuickAction([p(0, false, true), p(1, true, false)], true);
    expect(route).toEqual({ panelId: 1, delivery: 'prefill' });
  });

  it('falls back to the rightmost panel when every input holds a draft', () => {
    const route = routeQuickAction([p(2, false, true), p(1, true, true), p(0, true, true)], true);
    expect(route).toEqual({ panelId: 0, delivery: 'prefill' });
  });

  it('falls back to panel 0 when no panels are reported', () => {
    // Defensive: a panel that has not registered its handle yet must not send
    // the action into the void.
    expect(routeQuickAction([], true)).toEqual({ panelId: 0, delivery: 'prefill' });
  });
});

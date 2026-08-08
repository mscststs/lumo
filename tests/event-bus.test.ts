/**
 * Cross-context event bus contract.
 *
 * The property that makes or breaks this bus is local delivery.
 * `chrome.runtime.sendMessage` fires `onMessage` in every extension page *except
 * the frame that sent it*, and the main producer/consumer pair for
 * `files:changed` lives in the same frame: MCP tools execute in the side panel,
 * and `ConversationFiles` renders there too. A bus that only broadcast would
 * notify every context except the one where the change happened — which is the
 * one most likely to be showing the stale data.
 *
 * The second property is that emitting must never throw into the caller.
 * `sendMessage` throws synchronously once the context is invalidated instead of
 * returning a rejected promise, so a write path that emits would start failing
 * for a reason unrelated to the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitEvent, onEvent, resetEventBusForTests } from '@/lib/event-bus';

type Listener = (message: unknown, sender: unknown, respond: unknown) => boolean | void;

let listeners: Listener[] = [];
let sent: unknown[] = [];
/** Set to make `sendMessage` behave like an invalidated context. */
let sendThrows = false;
/** Set to make `sendMessage` reject, as it does with no other context open. */
let sendRejects = false;

beforeEach(() => {
  listeners = [];
  sent = [];
  sendThrows = false;
  sendRejects = false;

  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (fn: Listener) => void listeners.push(fn),
        removeListener: (fn: Listener) => {
          listeners = listeners.filter((l) => l !== fn);
        },
      },
      sendMessage: (message: unknown) => {
        if (sendThrows) throw new Error('Extension context invalidated.');
        sent.push(message);
        if (sendRejects) return Promise.reject(new Error('Receiving end does not exist.'));
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  resetEventBusForTests();
  vi.unstubAllGlobals();
});

/** Simulate the event arriving from another context. */
function deliverFromRemote(message: unknown) {
  for (const listener of [...listeners]) listener(message, {}, () => {});
}

describe('local delivery', () => {
  it('delivers to subscribers in the emitting context', () => {
    // sendMessage skips the sending frame, so without this the side panel would
    // never learn about a file its own tool just wrote.
    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));

    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });

    expect(seen).toEqual([{ names: ['a.md'], reason: 'write' }]);
  });

  it('delivers to every subscriber of the same event', () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    onEvent('files:changed', (p) => first.push(p));
    onEvent('files:changed', (p) => second.push(p));

    emitEvent('files:changed', { names: ['a.md'], reason: 'delete' });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: unknown[] = [];
    const off = onEvent('files:changed', (p) => seen.push(p));

    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });
    off();
    emitEvent('files:changed', { names: ['b.md'], reason: 'write' });

    expect(seen).toHaveLength(1);
  });

  it('treats a repeated unsubscribe as a no-op', () => {
    const seen: unknown[] = [];
    const off = onEvent('files:changed', (p) => seen.push(p));
    off();
    off();

    // A second handler added after the double-unsubscribe must still work.
    onEvent('files:changed', (p) => seen.push(p));
    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });

    expect(seen).toHaveLength(1);
  });

  it('isolates one throwing subscriber from the others', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: unknown[] = [];
    onEvent('files:changed', () => {
      throw new Error('subscriber is broken');
    });
    onEvent('files:changed', (p) => seen.push(p));

    expect(() => emitEvent('files:changed', { names: ['a.md'], reason: 'write' })).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('lets a handler unsubscribe during dispatch without skipping the rest', () => {
    const seen: string[] = [];
    const off = onEvent('files:changed', () => {
      seen.push('first');
      off();
    });
    onEvent('files:changed', () => seen.push('second'));

    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });

    expect(seen).toEqual(['first', 'second']);
  });
});

describe('cross-context delivery', () => {
  it('broadcasts an enveloped message', () => {
    onEvent('files:changed', () => {});
    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });

    expect(sent).toEqual([
      { lumoEvent: 'files:changed', payload: { names: ['a.md'], reason: 'write' } },
    ]);
  });

  it('broadcasts even with no local subscriber', () => {
    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });
    expect(sent).toHaveLength(1);
  });

  it('delivers an event that arrived from another context', () => {
    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));

    deliverFromRemote({ lumoEvent: 'files:changed', payload: { names: ['x.md'], reason: 'delete' } });

    expect(seen).toEqual([{ names: ['x.md'], reason: 'delete' }]);
  });

  it('does not re-broadcast an event it received', () => {
    onEvent('files:changed', () => {});
    deliverFromRemote({ lumoEvent: 'files:changed', payload: { names: ['x.md'], reason: 'write' } });
    // Otherwise two listening contexts would bounce the event forever.
    expect(sent).toHaveLength(0);
  });

  it('ignores foreign traffic on the shared channel', () => {
    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));

    deliverFromRemote({ type: 'lumo:page:read' });
    deliverFromRemote({ type: 'webmcp:tools-report' });
    deliverFromRemote(undefined);
    deliverFromRemote('a string');

    expect(seen).toHaveLength(0);
  });

  it('never claims the response port', () => {
    // Returning true would close the port for the page and WebMCP handlers that
    // answer real requests on this same channel.
    onEvent('files:changed', () => {});
    const results = listeners.map((l) =>
      l({ lumoEvent: 'files:changed', payload: { names: [], reason: 'write' } }, {}, () => {}),
    );
    expect(results.every((r) => r === false)).toBe(true);
  });

  it('does not deliver an event to a subscriber of a different type', () => {
    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));
    deliverFromRemote({ lumoEvent: 'something:else', payload: {} });
    expect(seen).toHaveLength(0);
  });
});

describe('emit is always safe', () => {
  it('swallows a rejected broadcast, which is the normal single-context case', () => {
    sendRejects = true;
    expect(() => emitEvent('files:changed', { names: ['a.md'], reason: 'write' })).not.toThrow();
  });

  it('swallows the synchronous throw of an invalidated context', () => {
    sendThrows = true;
    // The write that triggered this must not fail because nobody was listening.
    expect(() => emitEvent('files:changed', { names: ['a.md'], reason: 'write' })).not.toThrow();
  });

  it('still delivers locally when the broadcast throws', () => {
    sendThrows = true;
    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));

    emitEvent('files:changed', { names: ['a.md'], reason: 'write' });

    expect(seen).toHaveLength(1);
  });

  it('works with no chrome global at all', () => {
    vi.unstubAllGlobals();
    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));

    expect(() => emitEvent('files:changed', { names: ['a.md'], reason: 'write' })).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('listener lifecycle', () => {
  it('attaches exactly one runtime listener regardless of subscriber count', () => {
    onEvent('files:changed', () => {});
    onEvent('files:changed', () => {});
    expect(listeners).toHaveLength(1);
  });

  it('detaches once the last subscriber leaves', () => {
    const first = onEvent('files:changed', () => {});
    const second = onEvent('files:changed', () => {});

    first();
    expect(listeners).toHaveLength(1);
    second();
    expect(listeners).toHaveLength(0);
  });

  it('re-attaches after going idle', () => {
    onEvent('files:changed', () => {})();
    expect(listeners).toHaveLength(0);

    const seen: unknown[] = [];
    onEvent('files:changed', (p) => seen.push(p));
    expect(listeners).toHaveLength(1);

    deliverFromRemote({ lumoEvent: 'files:changed', payload: { names: [], reason: 'write' } });
    expect(seen).toHaveLength(1);
  });
});

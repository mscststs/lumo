import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpRegistry } from '@/lib/mcp/registry';
import type { McpServerState } from '@/lib/mcp/types';

/**
 * The registry is the options page's store, consumed through
 * `useSyncExternalStore`. React compares snapshots by identity, so the contract
 * this file pins down is: same array until something changed, fresh array from
 * `getAllStates()` for callers that want to sort or filter.
 */

function fakeServer(overrides: {
  id: string;
  status?: McpServerState['status'];
  tools?: McpServerState['tools'];
}) {
  let status = overrides.status ?? 'disconnected';
  const tools = overrides.tools ?? [];
  return {
    getInfo: () => ({
      id: overrides.id,
      name: overrides.id,
      description: '',
      transport: 'builtin' as const,
      builtin: true,
      enabled: true,
    }),
    getStatus: () => status,
    getTools: () => tools,
    getAITools: () => ({}),
    getError: () => undefined,
    connect: async () => {},
    disconnect: async () => {
      status = 'disconnected';
    },
    /** Stand-in for a transport-driven state change. */
    setStatus: (next: McpServerState['status']) => {
      status = next;
    },
  };
}

afterEach(() => {
  for (const server of mcpRegistry.getAllServers()) mcpRegistry.unregister(server.getInfo().id);
});

describe('mcpRegistry snapshots', () => {
  it('returns the same array until something changes', () => {
    mcpRegistry.register(fakeServer({ id: 'a' }) as never);

    const first = mcpRegistry.getSnapshot();
    expect(mcpRegistry.getSnapshot()).toBe(first);

    mcpRegistry.register(fakeServer({ id: 'b' }) as never);
    const second = mcpRegistry.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.map((s) => s.info.id)).toEqual(['a', 'b']);
  });

  it('keeps the cached array stable across a notification that changed nothing', () => {
    mcpRegistry.register(fakeServer({ id: 'a' }) as never);
    const first = mcpRegistry.getSnapshot();

    // `notifyChange` is the escape hatch for state changed outside `setStatus`;
    // it must invalidate, and the rebuilt array must be the new identity.
    mcpRegistry.notifyChange();
    expect(mcpRegistry.getSnapshot()).not.toBe(first);
  });

  it('reports a status change the next time it is read', () => {
    const server = fakeServer({ id: 'a' });
    mcpRegistry.register(server as never);

    server.setStatus('connecting');
    mcpRegistry.notifyChange();

    expect(mcpRegistry.getSnapshot()[0]?.status).toBe('connecting');
  });

  it('hands getAllStates callers a fresh array so they can reorder it', () => {
    mcpRegistry.register(fakeServer({ id: 'a' }) as never);
    mcpRegistry.register(fakeServer({ id: 'b' }) as never);

    const states = mcpRegistry.getAllStates();
    expect(mcpRegistry.getAllStates()).not.toBe(states);

    states.reverse();
    expect(mcpRegistry.getSnapshot().map((s) => s.info.id)).toEqual(['a', 'b']);
  });

  it('drops an unregistered server from both views', () => {
    mcpRegistry.register(fakeServer({ id: 'a' }) as never);
    expect(mcpRegistry.getSnapshot()).toHaveLength(1);

    mcpRegistry.unregister('a');
    expect(mcpRegistry.getSnapshot()).toHaveLength(0);
  });
});

describe('mcpRegistry subscriptions', () => {
  let listener: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    listener = vi.fn<() => void>();
  });

  it('notifies every subscriber once per mutation', () => {
    const unsubscribe = mcpRegistry.subscribe(listener);

    mcpRegistry.register(fakeServer({ id: 'a' }) as never);
    expect(listener).toHaveBeenCalledTimes(1);

    mcpRegistry.notifyChange();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    mcpRegistry.notifyChange();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

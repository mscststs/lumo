import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpHttpServerConfig } from '@/lib/mcp/types';

/**
 * `tools/list` is the one step of a connection that has no deadline of its own.
 *
 * `@ai-sdk/mcp` bounds a request only when a timeout travels with it:
 * `initializationOptions.timeout` stops at the handshake. A server that accepted
 * the connection and then stopped answering `tools/list` (a proxy holding the
 * socket, an SSE stream that never yields) left `connect()` pending forever —
 * which is what the options page reported as "loading forever". These tests pin
 * down the three properties that keep it bounded:
 *
 *  1. a deadline is passed with every page request;
 *  2. the budget is total, so pagination cannot multiply it — and a cursor that
 *     never ends is a hard error, not an infinite loop;
 *  3. the tool surface is built from the pages already listed, so a connection
 *     pays for one listing, not two.
 */

const mocks = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
  resolveEra: vi.fn(),
  rememberEra: vi.fn(),
  forgetEra: vi.fn(),
}));

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mocks.createMCPClient,
  auth: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  MCPClientOAuthError: Object.assign(class MCPClientOAuthError extends Error {}, {
    isInstance: () => false,
  }),
}));

vi.mock('@/lib/mcp/protocol-era-store', () => ({
  resolveEra: mocks.resolveEra,
  rememberEra: mocks.rememberEra,
  forgetEra: mocks.forgetEra,
}));

const { ExternalMcpServer } = await import('@/lib/mcp/external-server');

const config: McpHttpServerConfig = {
  id: 'ext-remote',
  name: 'Remote',
  description: '',
  transport: 'http-stream',
  url: 'https://example.test/mcp',
  enabled: true,
};

interface ListCall {
  cursor?: string;
  timeout?: number;
}

function baseClient(overrides: Record<string, unknown>) {
  return {
    initializeResult: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      serverInfo: { name: 'remote', version: '1.0.0' },
    },
    close: async () => {},
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ExternalMcpServer tools/list budget', () => {
  it('passes a deadline with every page request', async () => {
    const calls: ListCall[] = [];
    mocks.resolveEra.mockResolvedValue('modern');
    mocks.createMCPClient.mockResolvedValue(
      baseClient({
        listTools: async ({ params, options }: { params?: { cursor?: string }; options?: { timeout?: number } }) => {
          calls.push({ cursor: params?.cursor, timeout: options?.timeout });
          return params?.cursor == null
            ? { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'page-2' }
            : { tools: [{ name: 'b', inputSchema: {} }] };
        },
        toolsFromDefinitions: () => ({}),
      }),
    );

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('connected');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cursor).toBeUndefined();
    expect(calls[1]?.cursor).toBe('page-2');
    for (const call of calls) {
      expect(call.timeout).toBeGreaterThan(0);
    }
  });

  it('builds the tool surface from the pages it listed instead of listing twice', async () => {
    const listTools = vi.fn(async () => ({
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
    }));
    // A real `MCPClient.tools()` would list the surface again; the fake fails the
    // test if the server ever takes that path.
    const tools = vi.fn(async () => {
      throw new Error('tools() must not be called: its listing has no deadline');
    });
    const toolsFromDefinitions = vi.fn(() => ({ search: { description: 'Search' } }));

    mocks.resolveEra.mockResolvedValue('modern');
    mocks.createMCPClient.mockResolvedValue(
      baseClient({ listTools, tools, toolsFromDefinitions }),
    );

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(tools).not.toHaveBeenCalled();
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(toolsFromDefinitions).toHaveBeenCalledTimes(1);
    expect(server.getTools().map((t) => t.name)).toEqual(['search']);
    expect(Object.keys(server.getAITools())).toEqual(['search']);
  });

  it('fails instead of looping when the cursor never ends', async () => {
    let pages = 0;
    mocks.resolveEra.mockResolvedValue('modern');
    mocks.createMCPClient.mockResolvedValue(
      baseClient({
        listTools: async () => {
          pages += 1;
          return { tools: [], nextCursor: `page-${pages + 1}` };
        },
        toolsFromDefinitions: () => ({}),
      }),
    );

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toMatch(/pages of tools/);
    // The cap, not the deadline, is what ends the loop: the endpoint answers.
    expect(pages).toBe(50);
  });

  it('drops a client whose close never settles instead of holding the lock', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => {}));

    mocks.resolveEra.mockResolvedValue('modern');
    mocks.createMCPClient.mockResolvedValue(
      baseClient({
        listTools: async () => ({ tools: [] }),
        toolsFromDefinitions: () => ({}),
        close,
      }),
    );

    const server = new ExternalMcpServer(config);
    await server.connect();

    // `MCPClient.close()` terminates a legacy session over HTTP without a signal
    // of its own, and this await sits inside the cross-context connection lock.
    const disconnecting = server.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    await disconnecting;

    expect(close).toHaveBeenCalled();
    expect(server.getStatus()).toBe('disconnected');
  });

  it('lands on error when a stalled endpoint exhausts the budget', async () => {
    vi.useFakeTimers();
    const timeouts: Array<number | undefined> = [];

    mocks.resolveEra.mockResolvedValue('modern');
    mocks.createMCPClient.mockResolvedValue(
      baseClient({
        // Models the SDK: the request settles only when the timeout it was
        // given elapses.
        listTools: ({ options }: { options?: { timeout?: number } }) => {
          timeouts.push(options?.timeout);
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), options?.timeout ?? 0);
          });
        },
        toolsFromDefinitions: () => ({}),
      }),
    );

    const server = new ExternalMcpServer(config);
    const connecting = server.connect();
    // Three attempts (initial + two transient retries) of a 15s budget each,
    // plus 250ms/1s of backoff.
    await vi.advanceTimersByTimeAsync(120_000);
    await connecting;

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toMatch(/timed out/i);
    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeout of timeouts) expect(timeout).toBeGreaterThan(0);
  });
});

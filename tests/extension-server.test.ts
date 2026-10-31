import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpExtensionProviderConfig } from '@/lib/mcp/types';

interface FakeTransport {
  isClosed: boolean;
  onclose?: () => void;
  onDisconnect?: () => void;
  close: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  createClient: vi.fn(),
  transports: [] as FakeTransport[],
}));

vi.mock('@/lib/mcp/extension-probe', () => ({ probeExtension: mocks.probe }));
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: async ({ transport }: { transport: FakeTransport }) => {
    mocks.createClient();
    // Match @ai-sdk/mcp: the client owns `transport.onclose`.
    transport.onclose = () => {};
    return {
      initializeResult: {},
      listTools: mocks.listTools,
      callTool: mocks.callTool,
      close: async () => {},
    };
  },
}));
vi.mock('@/lib/mcp/transports/chrome-port', () => ({
  ChromePortTransport: {
    connect: () => {
      const transport: FakeTransport = {
        isClosed: false,
        onclose: undefined,
        onDisconnect: undefined,
        close: async () => {
          transport.isClosed = true;
        },
      };
      mocks.transports.push(transport);
      return transport;
    },
  },
}));

const { ExtensionMcpServer } = await import('@/lib/mcp/extension-server');

const EXT_A = 'a'.repeat(32);

const config: McpExtensionProviderConfig = { id: EXT_A, enabled: true };

function probeOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    response: {
      ok: true,
      service: { namespace: 'userscripts', name: 'Lumo Userscripts', version: '0.1.0' },
      status: { enabled: true, authorized: true, ready: true },
      ...overrides,
    },
  };
}

beforeEach(() => {
  mocks.transports.length = 0;
  mocks.createClient.mockClear();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'b'.repeat(32),
      getManifest: () => ({ version: '0.1.0' }),
      connect: () => ({}),
    },
  });
  mocks.probe.mockResolvedValue(probeOk());
  mocks.listTools.mockResolvedValue({
    tools: [
      {
        name: 'list',
        description: 'List scripts',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get',
        description: 'Get a script',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  });
  mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ExtensionMcpServer', () => {
  it('namespaces tools under the provider service', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('connected');
    expect(server.getTools().map((tool) => tool.name)).toEqual([
      'userscripts_list',
      'userscripts_get',
    ]);
    expect(Object.keys(server.getAITools())).toEqual(['userscripts_list', 'userscripts_get']);
    expect(server.getInfo().transport).toBe('extension');
  });

  it('reconnects when the port closes under a live session', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();
    expect(mocks.createClient).toHaveBeenCalledTimes(1);

    // The provider's service worker went idle: the physical port is closed, but
    // the server still holds the previous client and tool list.
    mocks.transports[0]!.isClosed = true;

    const aiTool = server.getAITools().userscripts_list as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    await aiTool.execute({}, { toolCallId: '1', messages: [] });

    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(server.getStatus()).toBe('connected');
    expect(mocks.callTool).toHaveBeenCalledWith({ name: 'list', arguments: {} });
  });

  it('routes tool calls to the provider local name', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();

    const aiTool = server.getAITools().userscripts_list as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    const result = await aiTool.execute({}, { toolCallId: '1', messages: [] });

    expect(mocks.callTool).toHaveBeenCalledWith({ name: 'list', arguments: {} });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('fails closed when the provider does not allow this extension', async () => {
    mocks.probe.mockResolvedValue(
      probeOk({ status: { enabled: true, authorized: false, ready: true } }),
    );
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toContain('does not allow this extension');
  });

  it('explains a pending approval instead of a generic refusal', async () => {
    mocks.probe.mockResolvedValue(
      probeOk({
        status: { enabled: true, authorized: false, ready: true, pendingApproval: true },
      }),
    );
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toContain('waiting for you to approve');
  });

  it('reports a disabled provider instead of connecting', async () => {
    mocks.probe.mockResolvedValue(
      probeOk({ status: { enabled: false, authorized: true, ready: true } }),
    );
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toContain('turned off');
  });

  it('reports an unreachable extension', async () => {
    mocks.probe.mockResolvedValue({ ok: false, error: 'nope', unreachable: true });
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toContain('not installed');
  });
});

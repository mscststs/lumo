import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpSettings } from '@/lib/mcp/types';

/**
 * Registration and connection are two contracts, and this file is what keeps
 * them apart.
 *
 * The options page used to await `initBuiltinMcpServers()`, i.e. registration
 * *and* every server's network handshake, before it rendered a single card. One
 * remote endpoint that never finished `tools/list` therefore held the whole page
 * on a spinner. The fix is structural, so the regression it must never allow is
 * "a page-level await covers a connection again".
 */

const settings: McpSettings = {
  servers: [
    {
      id: 'external-1',
      name: 'Remote',
      description: '',
      transport: 'http-stream',
      url: 'https://example.test/mcp',
      enabled: true,
    },
  ],
  extensionProviders: [],
  webmcpEnabled: false,
  disabledBuiltins: [],
};

const mocks = vi.hoisted(() => ({
  getMcpSettings: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getMcpSettings: mocks.getMcpSettings,
    setMcpSettings: async () => {},
  },
}));

/**
 * An external server whose handshake never settles — the worst case a page can
 * meet. `connect()` returning a pending promise is exactly the shape that used
 * to freeze the options page.
 */
vi.mock('@/lib/mcp/external-server', () => ({
  ExternalMcpServer: class {
    constructor(private config: { id: string; name: string; url: string; transport: string; enabled: boolean }) {}
    getInfo() {
      return {
        id: this.config.id,
        name: this.config.name,
        description: '',
        transport: this.config.transport,
        builtin: false,
        enabled: this.config.enabled,
      };
    }
    getStatus() {
      return 'connecting';
    }
    getTools() {
      return [];
    }
    getAITools() {
      return {};
    }
    getError() {
      return undefined;
    }
    connect() {
      mocks.connect();
      return new Promise<void>(() => {});
    }
    disconnect() {
      mocks.disconnect();
      return Promise.resolve();
    }
  },
  hasAuthorizationHeader: () => false,
}));

vi.mock('@/lib/mcp/extension-registry', () => ({
  initExtensionProviders: () => {},
  syncExtensionProviders: () => {},
  refreshExtensionProvider: async () => {},
  retryExtensionProviders: () => {},
  getExtensionProvider: () => undefined,
}));

vi.mock('@/lib/mcp/file-storage', () => ({
  fileStorage: {
    migrateLegacyShellArtifacts: async () => {},
    pruneTempFiles: async () => {},
  },
}));

vi.mock('@/lib/mcp/protocol-era-store', () => ({
  resolveEra: async () => undefined,
  rememberEra: async () => {},
  forgetEra: async () => {},
}));

vi.stubGlobal('chrome', {
  storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
});

const { initMcpRegistry, initBuiltinMcpServers, connectAllInBackground } = await import(
  '@/lib/mcp/index'
);
const { mcpRegistry } = await import('@/lib/mcp/registry');

/** Let every already-resolved promise run, then report whether `promise` settled. */
async function settledWithin(promise: Promise<unknown>, ms = 20): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

beforeEach(() => {
  mocks.getMcpSettings.mockResolvedValue(structuredClone(settings));
  mocks.connect.mockClear();
});

describe('MCP registration contract', () => {
  it('registers every configured server without opening a single connection', async () => {
    await initMcpRegistry();

    expect(mcpRegistry.getServer('external-1')).toBeDefined();
    // Built-ins are registered too: the first frame renders them from here.
    expect(mcpRegistry.getServer('browser')).toBeDefined();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('is single-flight: concurrent callers share one settings read', async () => {
    await Promise.all([initMcpRegistry(), initMcpRegistry(), initMcpRegistry()]);
    expect(mocks.getMcpSettings).toHaveBeenCalledTimes(1);
  });

  it('does not touch the network when asked to register only', async () => {
    expect(await settledWithin(initMcpRegistry())).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('keeps connectAllInBackground off the caller’s critical path', async () => {
    connectAllInBackground();

    // The handshake is pending forever, yet the call returned immediately.
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mcpRegistry.getServer('external-1')?.getStatus()).toBe('connecting');
  });

  it('still lets a caller that wants connections wait for them', async () => {
    // `initBuiltinMcpServers` is the explicit "registration + connection" entry
    // point; the background worker uses it. It must not resolve while a
    // handshake is pending.
    expect(await settledWithin(initBuiltinMcpServers())).toBe(false);
    expect(mocks.connect).toHaveBeenCalled();
  });
});

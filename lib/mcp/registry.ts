import type { IMcpServer, McpServerState, AnyTool } from './types';

/**
 * MCP Registry - manages all MCP server instances (built-in and external).
 * Provides a unified interface to discover tools across all connected servers.
 */
class McpRegistry {
  private servers: Map<string, IMcpServer> = new Map();
  private listeners: Set<() => void> = new Set();

  /**
   * Register an MCP server instance
   */
  register(server: IMcpServer): void {
    const info = server.getInfo();
    this.servers.set(info.id, server);
    this.notifyListeners();
  }

  /**
   * Unregister an MCP server by ID
   */
  unregister(id: string): void {
    const server = this.servers.get(id);
    if (server) {
      server.disconnect().catch(console.error);
      this.servers.delete(id);
      this.notifyListeners();
    }
  }

  /**
   * Get a specific server by ID
   */
  getServer(id: string): IMcpServer | undefined {
    return this.servers.get(id);
  }

  /**
   * Get all registered servers
   */
  getAllServers(): IMcpServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get all server states (for UI display)
   */
  getAllStates(): McpServerState[] {
    return this.getAllServers().map((server) => ({
      info: server.getInfo(),
      status: server.getStatus(),
      tools: server.getTools(),
      error: server.getError(),
    }));
  }

  /**
   * Connect all enabled servers
   */
  async connectAll(): Promise<void> {
    const servers = this.getAllServers().filter(
      (s) => s.getInfo().enabled
    );
    await Promise.allSettled(servers.map((s) => s.connect()));
    this.notifyListeners();
  }

  /**
   * Disconnect all servers
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      this.getAllServers().map((s) => s.disconnect())
    );
    this.notifyListeners();
  }

  /**
   * Get all AI SDK compatible tools from all connected servers.
   * Returns a merged tools object that can be passed directly to streamText/generateText.
   */
  getAllAITools(): Record<string, AnyTool> {
    const allTools: Record<string, AnyTool> = {};
    
    for (const server of this.getAllServers()) {
      if (server.getStatus() === 'connected' && server.getInfo().enabled) {
        const tools = server.getAITools();
        Object.assign(allTools, tools);
      }
    }

    return allTools;
  }

  /**
   * Subscribe to registry state changes
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** Singleton registry instance */
export const mcpRegistry = new McpRegistry();

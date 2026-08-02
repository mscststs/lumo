import type { IMcpServer, McpServerState, McpToolExecutionContext, AnyTool } from './types';

/**
 * Check if a value is already a MCP CallToolResult structure.
 * CallToolResult: { content: [{type: "text", text: "..."}, ...], isError?: boolean }
 */
function isCallToolResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.content);
}

/**
 * Normalize a tool execute result into MCP CallToolResult format.
 * - If already a CallToolResult, return as-is.
 * - If it's an error-shaped object { error: "..." }, wrap as isError: true.
 * - Otherwise wrap the value as a text content part.
 */
function normalizeToCallToolResult(result: unknown): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  // Already a CallToolResult
  if (isCallToolResult(result)) {
    return result as { content: Array<{ type: string; text: string }>; isError: boolean };
  }

  // Error-shaped object from built-in tools: { error: "message" }
  if (
    result &&
    typeof result === 'object' &&
    typeof (result as Record<string, unknown>).error === 'string' &&
    Object.keys(result as object).length <= 2
  ) {
    return {
      content: [{ type: 'text', text: (result as Record<string, unknown>).error as string }],
      isError: true,
    };
  }

  // Normal result — stringify and wrap
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Wrap a tool's execute function so its output is always a CallToolResult.
 */
function wrapToolExecute(originalTool: AnyTool): AnyTool {
  const originalExecute = (originalTool as any).execute;
  if (typeof originalExecute !== 'function') return originalTool;

  return {
    ...originalTool,
    execute: async (...args: any[]) => {
      const result = await originalExecute(...args);
      return normalizeToCallToolResult(result);
    },
  } as AnyTool;
}

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
   * All tool execute outputs are normalized to MCP CallToolResult format.
   * @param context Optional execution context captured in tool closures for the current stream.
   */
  getAllAITools(context?: McpToolExecutionContext): Record<string, AnyTool> {
    const allTools: Record<string, AnyTool> = {};
    
    for (const server of this.getAllServers()) {
      if (server.getStatus() === 'connected' && server.getInfo().enabled) {
        const tools = server.getAITools(context);
        for (const [name, t] of Object.entries(tools)) {
          allTools[name] = wrapToolExecute(t);
        }
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

  /**
   * Notify all subscribers of a state change.
   * Call after modifying a server's state externally (e.g. connect/disconnect).
   */
  notifyChange(): void {
    this.notifyListeners();
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** Singleton registry instance */
export const mcpRegistry = new McpRegistry();

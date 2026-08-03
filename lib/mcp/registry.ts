import type { IMcpServer, McpServerState, McpToolExecutionContext, AnyTool } from './types';

/**
 * Check if a value is already a MCP CallToolResult structure.
 * CallToolResult: { content: [{type: "text", text}, {type: "image", data, mimeType}, ...], isError?: boolean }
 */
function isCallToolResult(value: unknown): value is {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
} {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.content);
}

/** Parse a `data:<mime>;base64,<payload>` URL into its parts. */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | undefined {
  const comma = dataUrl.indexOf(',');
  if (comma <= 0) return undefined;
  const header = dataUrl.slice(5, comma); // strip leading "data:"
  return { mimeType: header.split(';')[0] || 'image/png', data: dataUrl.slice(comma + 1) };
}

/**
 * Recursively collect base64 image data-URLs from an arbitrary tool result.
 * Lets ANY tool that embeds an image (screenshots, charts, OCR results, …) be
 * surfaced as a structured `image` content part instead of a giant text blob.
 */
function collectImageParts(
  value: unknown,
  images: Array<{ type: 'image'; data: string; mimeType: string }> = [],
): Array<{ type: 'image'; data: string; mimeType: string }> {
  if (value == null || typeof value !== 'object') return images;
  if (Array.isArray(value)) {
    for (const item of value) collectImageParts(item, images);
    return images;
  }
  for (const val of Object.values(value)) {
    if (typeof val === 'string' && val.startsWith('data:image/')) {
      const parsed = parseDataUrl(val);
      if (parsed) images.push({ type: 'image', data: parsed.data, mimeType: parsed.mimeType });
    } else if (val && typeof val === 'object') {
      collectImageParts(val, images);
    }
  }
  return images;
}

/** Stringify a tool result, replacing base64 image data-URLs with a compact placeholder. */
function stringifyWithoutImages(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === 'string' && v.startsWith('data:image/')) {
          const comma = v.indexOf(',');
          const sizeKb = comma > 0 ? ((v.length - comma - 1) / 1024).toFixed(0) : '';
          return `[image ${sizeKb}KB]`;
        }
        return v;
      }) ?? ''
    );
  } catch {
    return '';
  }
}

/**
 * Normalize a tool execute result into MCP CallToolResult format.
 * - If already a CallToolResult, return as-is (images preserved).
 * - If it's an error-shaped object { error: "..." }, wrap as isError: true.
 * - If it contains base64 image data-URLs, split them out into `image` content
 *   parts followed by a compact text summary.
 * - Otherwise wrap the value as a text content part.
 */
export function normalizeToCallToolResult(result: unknown): {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError: boolean;
} {
  // Already a CallToolResult
  if (isCallToolResult(result)) {
    return result as { content: Array<{ type: string; [key: string]: unknown }>; isError: boolean };
  }

  // A bare base64 image data-URL
  if (typeof result === 'string') {
    if (result.startsWith('data:image/')) {
      const parsed = parseDataUrl(result);
      if (parsed) {
        return { content: [{ type: 'image', data: parsed.data, mimeType: parsed.mimeType }], isError: false };
      }
    }
    return { content: [{ type: 'text', text: result }], isError: false };
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

  // Image-bearing result — split into image + compact text parts
  const images = collectImageParts(result);
  if (images.length > 0) {
    return {
      content: [...images, { type: 'text', text: stringifyWithoutImages(result) }],
      isError: false,
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
 * Convert a normalized CallToolResult into a model-friendly output.
 *
 * Results carrying image content become `content` parts — the native format
 * both Anthropic (`tool_result` image blocks) and OpenAI Responses
 * (`input_image` in function outputs) understand. Text-only results keep the
 * legacy `json` shape so existing tools keep a byte-identical model prompt.
 */
export function mcpToModelOutput({
  output,
}: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}): unknown {
  const result = output as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  } | null;
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    return { type: 'json', value: output as never };
  }
  if (!result.content.some((part) => part.type === 'image')) {
    // Preserve legacy behavior: plain results are stringified as JSON.
    return { type: 'json', value: output as never };
  }
  return {
    type: 'content',
    value: result.content.map((part) => {
      if (part.type === 'text') {
        return { type: 'text' as const, text: part.text ?? '' };
      }
      if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
        return {
          type: 'file' as const,
          mediaType: part.mimeType,
          data: { type: 'data' as const, data: part.data },
        };
      }
      return { type: 'text' as const, text: JSON.stringify(part) };
    }),
  };
}

/**
 * Wrap a tool's execute function so its output is always a CallToolResult.
 * External MCP tools (from @ai-sdk/mcp) already ship their own `toModelOutput`,
 * so it is only added for tools that don't define one.
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
    ...((originalTool as any).toModelOutput == null ? { toModelOutput: mcpToModelOutput } : {}),
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

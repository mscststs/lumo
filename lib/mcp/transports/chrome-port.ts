import type { JSONRPCMessage, MCPTransport } from '@ai-sdk/mcp';
import { MCP_PORT_NAME } from '@/lib/mcp/extension-protocol';

/**
 * MCP transport over a `chrome.runtime.Port`.
 *
 * A Port is a duplex message channel, the same shape as MCP's stdio transport.
 * Messages that arrive before `start()` (the client installs its handlers and
 * then starts the transport) are buffered so the initial `initialize` response
 * cannot be missed.
 */
export class ChromePortTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protocolVersion?: string;
  /**
   * Called when the underlying Port disconnects.
   *
   * Separate from `onclose` because `@ai-sdk/mcp` assigns `transport.onclose`
   * itself (`createMCPClient` -> `this.transport.onclose = () => this.onClose()`).
   * Anything we put on `onclose` is overwritten the moment the client is
   * created, which left the cached client marked "connected" forever after the
   * provider's service worker went idle.
   */
  onDisconnect?: () => void;

  private active = false;
  private closed = false;
  private pending: JSONRPCMessage[] = [];

  constructor(
    private readonly port: chrome.runtime.Port,
    private readonly extensionId: string,
  ) {
    port.onMessage.addListener(this.handleMessage);
    port.onDisconnect.addListener(this.handleDisconnect);
  }

  /** Physical liveness. The SDK client can be closed while our state says connected. */
  get isClosed(): boolean {
    return this.closed;
  }

  static connect(extensionId: string): ChromePortTransport {
    return new ChromePortTransport(
      chrome.runtime.connect(extensionId, { name: MCP_PORT_NAME }),
      extensionId,
    );
  }

  async start(): Promise<void> {
    this.active = true;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error(`The MCP port for ${this.extensionId} is closed.`);
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.disconnect();
    } catch {
      // Already disconnected.
    }
    this.onclose?.();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private handleMessage = (message: unknown): void => {
    if (this.closed) return;
    if (!this.active) {
      this.pending.push(message as JSONRPCMessage);
      return;
    }
    this.onmessage?.(message as JSONRPCMessage);
  };

  private handleDisconnect = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.onDisconnect?.();
    this.onclose?.();
  };
}

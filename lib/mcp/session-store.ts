/**
 * Shared session-scoped state for built-in MCP servers.
 *
 * Long-lived collectors (webRequest, debugger events) can only run in the
 * background service worker, but the tools that read what they collected run
 * wherever `chatStream` runs (the side panel). In-memory arrays on a server
 * instance therefore never line up: each context owns a separate, mostly empty
 * copy, and the service worker's copy dies with it after ~30s idle.
 *
 * `chrome.storage.session` fixes both halves: it survives service worker
 * restarts, clears on browser restart (right lifetime for a debug log), and is
 * readable from every trusted context, so no message plumbing is needed.
 */

/** Captured network request, as surfaced by the network monitor tools. */
export interface NetworkRequestRecord {
  id: string;
  url: string;
  method: string;
  type: string;
  statusCode?: number;
  statusLine?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  timestamp: number;
  fromCache?: boolean;
  ip?: string;
  initiator?: string;
  error?: string;
}

/** A console message or uncaught exception collected over CDP. */
export interface ConsoleMessageRecord {
  level: string;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  timestamp: number;
  stackTrace?: string;
}

const NETWORK_KEY = 'mcp:networkRequests';
const CONSOLE_KEY = 'mcp:consoleMessages';
const ATTACHED_TABS_KEY = 'mcp:debuggerAttachedTabs';

/** Buffer caps. Session storage allows 10MB total, so keep well clear of it. */
const MAX_NETWORK_REQUESTS = 500;
const MAX_CONSOLE_MESSAGES = 200;

function sessionArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome !== 'undefined' ? chrome.storage?.session : undefined;
}

async function readArray<T>(key: string): Promise<T[]> {
  const area = sessionArea();
  if (!area) return [];
  const result = await area.get(key);
  const value = result[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Write `items`, shedding the oldest entries if the area rejects the write.
 *
 * A single oversized response header set is enough to blow the quota, and
 * silently losing the whole buffer would be worse than losing its tail. If even
 * a halved payload keeps failing the error is rethrown rather than swallowed, so
 * the caller can surface it instead of the log going quietly stale.
 */
async function writeArray<T>(key: string, items: T[]): Promise<void> {
  const area = sessionArea();
  if (!area) return;

  let payload = items;
  for (;;) {
    try {
      await area.set({ [key]: payload });
      return;
    } catch (error) {
      if (payload.length <= 1) throw error;
      payload = payload.slice(Math.ceil(payload.length / 2));
    }
  }
}

/**
 * A capped, session-persisted append-only log.
 *
 * `append` re-reads before writing rather than caching the list, so a `clear`
 * from another context is not clobbered by a later flush: only entries observed
 * after the clear are re-added.
 */
class SessionLog<T> {
  constructor(
    private readonly key: string,
    private readonly max: number,
  ) {}

  read(): Promise<T[]> {
    return readArray<T>(this.key);
  }

  async append(items: T[]): Promise<void> {
    if (items.length === 0) return;
    const current = await this.read();
    await writeArray(this.key, [...current, ...items].slice(-this.max));
  }

  async clear(): Promise<number> {
    const current = await this.read();
    await writeArray(this.key, []);
    return current.length;
  }
}

export const networkLog = new SessionLog<NetworkRequestRecord>(
  NETWORK_KEY,
  MAX_NETWORK_REQUESTS,
);

export const consoleLog = new SessionLog<ConsoleMessageRecord>(
  CONSOLE_KEY,
  MAX_CONSOLE_MESSAGES,
);

/**
 * Tabs the extension currently has a debugger attached to.
 *
 * Debugger attachment is per-extension, not per-context, so this must be shared
 * state: the side panel needs to know about an attach performed earlier by the
 * background worker, or it would try to attach twice.
 */
export const attachedTabs = {
  async read(): Promise<number[]> {
    return readArray<number>(ATTACHED_TABS_KEY);
  },

  async has(tabId: number): Promise<boolean> {
    return (await this.read()).includes(tabId);
  },

  async add(tabId: number): Promise<void> {
    const current = await this.read();
    if (current.includes(tabId)) return;
    await writeArray(ATTACHED_TABS_KEY, [...current, tabId]);
  },

  async remove(tabId: number): Promise<void> {
    const current = await this.read();
    if (!current.includes(tabId)) return;
    await writeArray(
      ATTACHED_TABS_KEY,
      current.filter((id) => id !== tabId),
    );
  },

  async clear(): Promise<void> {
    await writeArray(ATTACHED_TABS_KEY, []);
  },
};

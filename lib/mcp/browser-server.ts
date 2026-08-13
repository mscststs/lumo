import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool, WebMcpTabState } from './types';
import { WEBMCP_SESSION_KEY } from './webmcp-messages';

/**
 * Built-in Browser Core MCP Server
 * Provides 7 unified tools for interacting with Chrome browser APIs:
 * - browser_tabs: Tab management (list, create, close, update, move, duplicate, reload, group, ungroup)
 * - browser_windows: Window management (list, create, close, update)
 * - browser_navigate: Navigation control (goto, back, forward)
 * - browser_bookmarks: Bookmark CRUD (list, search, create, delete)
 * - browser_history: History management (search, delete)
 * - browser_cookies: Cookie operations (get, set, remove)
 * - browser_downloads: Download management (start, list, cancel)
 */
export class BrowserMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  /**
   * Wait for a tab to finish loading (status === 'complete').
   * Returns the updated tab info once loaded or after timeout.
   */
  private waitForTabLoad(tabId: number, timeout = 15000): Promise<chrome.tabs.Tab> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.get(tabId).then(resolve).catch(() => resolve({ id: tabId } as chrome.tabs.Tab));
      }, timeout);

      const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);

      // Check if already complete
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === 'complete') {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      }).catch(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({ id: tabId } as chrome.tabs.Tab);
        }
      });
    });
  }

  /**
   * Read WebMCP tab states from session storage.
   */
  private async getWebMcpTabStates(): Promise<WebMcpTabState[]> {
    try {
      const result = await chrome.storage.session.get(WEBMCP_SESSION_KEY);
      return (result[WEBMCP_SESSION_KEY] as WebMcpTabState[] | undefined) || [];
    } catch {
      return [];
    }
  }

  getInfo(): McpServerInfo {
    return {
      id: 'browser',
      name: 'Browser Core',
      description: 'Chrome browser APIs - tabs, windows, navigation, bookmarks, history, cookies, downloads',
      transport: 'builtin',
      builtin: true,
      enabled: true,
      icon: 'globe',
    };
  }

  async connect(): Promise<void> {
    try {
      this.status = 'connecting';
      if (typeof chrome === 'undefined' || !chrome.tabs) {
        throw new Error('Chrome APIs not available');
      }
      this.status = 'connected';
      this.error = undefined;
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  getStatus(): McpServerStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.error;
  }

  getTools(): McpToolDefinition[] {
    return Object.entries(this.getAITools()).map(([name, definition]) => ({
      name,
      description: (definition as { description?: string }).description ?? '',
      inputSchema: toJsonSchema((definition as { inputSchema?: unknown }).inputSchema),
    }));
  }

  getAITools(): Record<string, AnyTool> {
    return {
      browser_tabs: tool({
        description:
          'Manage browser tabs. Actions: list (all open tabs, optionally filtered by windowId), ' +
          'create (open a new tab with URL), close (close a tab by ID), update (change URL, pin, mute, activate), ' +
          'move (reposition a tab), duplicate, reload (with optional cache bypass), ' +
          'group (group tabs together with title/color), ungroup (remove tabs from group).',
        inputSchema: z.object({
          action: z.enum(['list', 'create', 'close', 'update', 'move', 'duplicate', 'reload', 'group', 'ungroup']).describe('The action to perform'),
          windowId: z.number().optional().describe('[list, move] Filter by window ID / Target window ID'),
          url: z.string().optional().describe('[create] URL to open'),
          active: z.boolean().optional().describe('[create, update] Whether the tab should become active'),
          tabId: z.number().optional().describe('[close, update, move, duplicate, reload] ID of the tab'),
          pinned: z.boolean().optional().describe('[update] Pin or unpin'),
          muted: z.boolean().optional().describe('[update] Mute or unmute'),
          index: z.number().optional().describe('[move] New position index'),
          bypassCache: z.boolean().optional().describe('[reload] Bypass cache on reload'),
          tabIds: z.array(z.number()).optional().describe('[group, ungroup] Array of tab IDs'),
          title: z.string().optional().describe('[group] Title for the tab group'),
          color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']).optional().describe('[group] Color for the tab group'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'list': {
              const queryInfo: chrome.tabs.QueryInfo = {};
              if (params.windowId !== undefined) queryInfo.windowId = params.windowId;
              const tabs = await chrome.tabs.query(queryInfo);
              const webmcpStates = await this.getWebMcpTabStates();
              const webmcpByTab = new Map(webmcpStates.filter((s) => s.tools.length > 0).map((s) => [s.tabId, s]));
              return tabs.map((tab) => {
                const base = {
                  id: tab.id,
                  title: tab.title,
                  url: tab.url,
                  active: tab.active,
                  windowId: tab.windowId,
                  pinned: tab.pinned,
                  index: tab.index,
                };
                const webmcpState = tab.id ? webmcpByTab.get(tab.id) : undefined;
                if (webmcpState) {
                  return { ...base, webmcp: webmcpState.tools.map((t) => ({ name: t.name, description: t.description })) };
                }
                return base;
              });
            }
            case 'create': {
              const tab = await chrome.tabs.create({ url: params.url, active: params.active !== undefined ? params.active : true });
              if (!tab.id) return { id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId };
              const loaded = await this.waitForTabLoad(tab.id);
              return { id: loaded.id, title: loaded.title, url: loaded.url, windowId: loaded.windowId, status: loaded.status };
            }
            case 'close': {
              await chrome.tabs.remove(params.tabId);
              return { success: true, closedTabId: params.tabId };
            }
            case 'update': {
              const updateProps: chrome.tabs.UpdateProperties = {};
              if (params.url !== undefined) updateProps.url = params.url;
              if (params.pinned !== undefined) updateProps.pinned = params.pinned;
              if (params.muted !== undefined) updateProps.muted = params.muted;
              if (params.active !== undefined) updateProps.active = params.active;
              await chrome.tabs.update(params.tabId, updateProps);
              if (params.url !== undefined) {
                const loaded = await this.waitForTabLoad(params.tabId);
                return { id: loaded.id, title: loaded.title, url: loaded.url, pinned: loaded.pinned, active: loaded.active, muted: loaded.mutedInfo?.muted, status: loaded.status };
              }
              const tab = await chrome.tabs.get(params.tabId);
              return { id: tab?.id, title: tab?.title, url: tab?.url, pinned: tab?.pinned, active: tab?.active, muted: tab?.mutedInfo?.muted };
            }
            case 'move': {
              const moveProps: chrome.tabs.MoveProperties = { index: params.index };
              if (params.windowId !== undefined) moveProps.windowId = params.windowId;
              const tab = await chrome.tabs.move(params.tabId, moveProps);
              const result = Array.isArray(tab) ? tab[0] : tab;
              return { id: result.id, windowId: result.windowId, index: result.index };
            }
            case 'duplicate': {
              const tab = await chrome.tabs.duplicate(params.tabId);
              return { id: tab?.id, title: tab?.title, url: tab?.url, windowId: tab?.windowId };
            }
            case 'reload': {
              await chrome.tabs.reload(params.tabId, { bypassCache: params.bypassCache || false });
              const loaded = await this.waitForTabLoad(params.tabId);
              return { success: true, reloadedTabId: params.tabId, url: loaded.url, title: loaded.title, status: loaded.status };
            }
            case 'group': {
              const groupId = await chrome.tabs.group({ tabIds: params.tabIds as [number, ...number[]] });
              if (params.title || params.color) {
                await chrome.tabGroups.update(groupId as number, {
                  ...(params.title && { title: params.title }),
                  ...(params.color && { color: params.color }),
                });
              }
              return { success: true, groupId };
            }
            case 'ungroup': {
              await chrome.tabs.ungroup(params.tabIds as [number, ...number[]]);
              return { success: true, ungroupedTabIds: params.tabIds };
            }
          }
        },
      }),

      browser_windows: tool({
        description:
          'Manage browser windows. Actions: list (all windows with properties), ' +
          'create (new window with optional URL, size, position, incognito), ' +
          'close (by ID), update (resize, move, minimize, maximize, fullscreen, focus).',
        inputSchema: z.object({
          action: z.enum(['list', 'create', 'close', 'update']).describe('The action to perform'),
          windowId: z.number().optional().describe('[close, update] ID of the window'),
          url: z.string().optional().describe('[create] URL to open in the new window'),
          incognito: z.boolean().optional().describe('[create] Open in incognito mode'),
          width: z.number().optional().describe('[create, update] Window width'),
          height: z.number().optional().describe('[create, update] Window height'),
          left: z.number().optional().describe('[create, update] Window left position'),
          top: z.number().optional().describe('[create, update] Window top position'),
          state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']).optional().describe('[update] Window state'),
          focused: z.boolean().optional().describe('[update] Bring window to front'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'list': {
              const windows = await chrome.windows.getAll({ populate: true });
              return windows.map((win) => ({
                id: win.id,
                focused: win.focused,
                state: win.state,
                type: win.type,
                width: win.width,
                height: win.height,
                left: win.left,
                top: win.top,
                tabCount: win.tabs?.length || 0,
                incognito: win.incognito,
              }));
            }
            case 'create': {
              const createData: chrome.windows.CreateData = {};
              if (params.url) createData.url = params.url;
              if (params.incognito !== undefined) createData.incognito = params.incognito;
              if (params.width !== undefined) createData.width = params.width;
              if (params.height !== undefined) createData.height = params.height;
              if (params.left !== undefined) createData.left = params.left;
              if (params.top !== undefined) createData.top = params.top;
              const win = await chrome.windows.create(createData);
              return { id: win?.id, state: win?.state, width: win?.width, height: win?.height };
            }
            case 'close': {
              await chrome.windows.remove(params.windowId);
              return { success: true, closedWindowId: params.windowId };
            }
            case 'update': {
              const updateInfo: chrome.windows.UpdateInfo = {};
              if (params.state) updateInfo.state = params.state;
              if (params.width !== undefined) updateInfo.width = params.width;
              if (params.height !== undefined) updateInfo.height = params.height;
              if (params.left !== undefined) updateInfo.left = params.left;
              if (params.top !== undefined) updateInfo.top = params.top;
              if (params.focused !== undefined) updateInfo.focused = params.focused;
              const win = await chrome.windows.update(params.windowId, updateInfo);
              return { id: win.id, state: win.state, width: win.width, height: win.height, left: win.left, top: win.top };
            }
          }
        },
      }),

      browser_navigate: tool({
        description:
          'Navigate a tab. Actions: goto (navigate to URL), back (go back in history), forward (go forward in history). ' +
          'All actions wait for the page to finish loading. If no tabId is specified, operates on the active tab.',
        inputSchema: z.object({
          action: z.enum(['goto', 'back', 'forward']).describe('The action to perform'),
          url: z.string().optional().describe('[goto] URL to navigate to'),
          tabId: z.number().optional().describe('Tab ID (defaults to active tab)'),
        }),
        execute: async (params: any) => {
          let targetTabId = params.tabId;
          if (!targetTabId) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTabId = activeTab?.id;
          }
          if (!targetTabId) return { error: 'No target tab found' };

          switch (params.action) {
            case 'goto': {
              await chrome.tabs.update(targetTabId, { url: params.url });
              const loaded = await this.waitForTabLoad(targetTabId);
              return { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status };
            }
            case 'back': {
              try {
                await chrome.tabs.goBack(targetTabId);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('Cannot find') || msg.includes('no page')) {
                  return { error: 'Cannot go back: no previous page in history', tabId: targetTabId };
                }
                return { error: `Navigation back failed: ${msg}` };
              }
              const loaded = await this.waitForTabLoad(targetTabId);
              return { success: true, tabId: targetTabId, url: loaded.url, title: loaded.title };
            }
            case 'forward': {
              try {
                await chrome.tabs.goForward(targetTabId);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('Cannot find') || msg.includes('no page')) {
                  return { error: 'Cannot go forward: no next page in history', tabId: targetTabId };
                }
                return { error: `Navigation forward failed: ${msg}` };
              }
              const loaded = await this.waitForTabLoad(targetTabId);
              return { success: true, tabId: targetTabId, url: loaded.url, title: loaded.title };
            }
          }
        },
      }),

      browser_bookmarks: tool({
        description:
          'Manage bookmarks. Actions: list (get bookmarks tree or folder contents), ' +
          'search (by title or URL keyword), create (new bookmark), delete (by ID).',
        inputSchema: z.object({
          action: z.enum(['list', 'search', 'create', 'delete']).describe('The action to perform'),
          folderId: z.string().optional().describe('[list] Folder ID (optional, returns full tree if omitted)'),
          query: z.string().optional().describe('[search] Search query string'),
          title: z.string().optional().describe('[create] Bookmark title'),
          url: z.string().optional().describe('[create] Bookmark URL'),
          parentId: z.string().optional().describe('[create] Parent folder ID'),
          bookmarkId: z.string().optional().describe('[delete] ID of the bookmark to delete'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'list': {
              if (params.folderId) {
                const results = await chrome.bookmarks.getChildren(params.folderId);
                return results.map((node) => ({
                  id: node.id, title: node.title, url: node.url, isFolder: !node.url, parentId: node.parentId,
                }));
              }
              const tree = await chrome.bookmarks.getTree();
              return flattenBookmarkTree(tree);
            }
            case 'search': {
              const results = await chrome.bookmarks.search(params.query);
              return results.map((node) => ({
                id: node.id, title: node.title, url: node.url, parentId: node.parentId,
              }));
            }
            case 'create': {
              const bookmark = await chrome.bookmarks.create({ title: params.title, url: params.url, parentId: params.parentId });
              return { id: bookmark.id, title: bookmark.title, url: bookmark.url, parentId: bookmark.parentId };
            }
            case 'delete': {
              await chrome.bookmarks.remove(params.bookmarkId);
              return { success: true, deletedId: params.bookmarkId };
            }
          }
        },
      }),

      browser_history: tool({
        description:
          'Manage browser history. Actions: search (search history by query with optional time range), ' +
          'delete (remove a specific URL from history).',
        inputSchema: z.object({
          action: z.enum(['search', 'delete']).describe('The action to perform'),
          query: z.string().optional().describe('[search] Search query string'),
          maxResults: z.number().optional().describe('[search] Maximum results (default 20)'),
          startTime: z.number().optional().describe('[search] Start time as ms since epoch'),
          endTime: z.number().optional().describe('[search] End time as ms since epoch'),
          url: z.string().optional().describe('[delete] URL to delete from history'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'search': {
              const searchParams: chrome.history.HistoryQuery = { text: params.query, maxResults: params.maxResults || 20 };
              if (params.startTime !== undefined) searchParams.startTime = params.startTime;
              if (params.endTime !== undefined) searchParams.endTime = params.endTime;
              const results = await chrome.history.search(searchParams);
              return results.map((item) => ({
                url: item.url, title: item.title, visitCount: item.visitCount, lastVisitTime: item.lastVisitTime,
              }));
            }
            case 'delete': {
              await chrome.history.deleteUrl({ url: params.url });
              return { success: true, deletedUrl: params.url };
            }
          }
        },
      }),

      browser_cookies: tool({
        description:
          'Manage cookies. Actions: get (cookies for a URL, optionally by name), ' +
          'set (create/update a cookie), remove (delete a cookie by URL and name).',
        inputSchema: z.object({
          action: z.enum(['get', 'set', 'remove']).describe('The action to perform'),
          url: z.string().describe('URL for the cookie operation'),
          name: z.string().optional().describe('[get] Filter by name; [set, remove] Cookie name'),
          value: z.string().optional().describe('[set] Cookie value'),
          domain: z.string().optional().describe('[set] Cookie domain'),
          path: z.string().optional().describe('[set] Cookie path'),
          secure: z.boolean().optional().describe('[set] Whether the cookie is secure'),
          httpOnly: z.boolean().optional().describe('[set] Whether the cookie is HTTP only'),
          expirationDate: z.number().optional().describe('[set] Expiration as seconds since epoch'),
          sameSite: z.enum(['no_restriction', 'lax', 'strict']).optional().describe('[set] SameSite attribute'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'get': {
              if (params.name) {
                const cookie = await chrome.cookies.get({ url: params.url, name: params.name });
                return cookie ? [cookie] : [];
              }
              const cookies = await chrome.cookies.getAll({ url: params.url });
              return cookies.map((c) => ({
                name: c.name, value: c.value, domain: c.domain, path: c.path,
                secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite,
              }));
            }
            case 'set': {
              const details: chrome.cookies.SetDetails = { url: params.url, name: params.name, value: params.value };
              if (params.domain) details.domain = params.domain;
              if (params.path) details.path = params.path;
              if (params.secure !== undefined) details.secure = params.secure;
              if (params.httpOnly !== undefined) details.httpOnly = params.httpOnly;
              if (params.expirationDate !== undefined) details.expirationDate = params.expirationDate;
              if (params.sameSite) details.sameSite = params.sameSite;
              const cookie = await chrome.cookies.set(details);
              return cookie ? { success: true, name: cookie.name, domain: cookie.domain } : { error: 'Failed to set cookie' };
            }
            case 'remove': {
              await chrome.cookies.remove({ url: params.url, name: params.name });
              return { success: true, removedCookie: params.name };
            }
          }
        },
      }),

      browser_downloads: tool({
        description:
          'Manage downloads. Actions: start (download a file from URL), ' +
          'list (search/list recent downloads), cancel (cancel an active download).',
        inputSchema: z.object({
          action: z.enum(['start', 'list', 'cancel']).describe('The action to perform'),
          url: z.string().optional().describe('[start] URL of the file to download'),
          filename: z.string().optional().describe('[start] Suggested filename'),
          saveAs: z.boolean().optional().describe('[start] Show "Save As" dialog'),
          query: z.string().optional().describe('[list] Search query to filter downloads'),
          limit: z.number().optional().describe('[list] Maximum results (default 20)'),
          downloadId: z.number().optional().describe('[cancel] ID of the download to cancel'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'start': {
              const options: chrome.downloads.DownloadOptions = { url: params.url };
              if (params.filename) options.filename = params.filename;
              if (params.saveAs !== undefined) options.saveAs = params.saveAs;
              const downloadId = await chrome.downloads.download(options);
              return { success: true, downloadId };
            }
            case 'list': {
              const searchQuery: chrome.downloads.DownloadQuery = {};
              if (params.query) searchQuery.filenameRegex = params.query;
              searchQuery.limit = params.limit || 20;
              const downloads = await chrome.downloads.search(searchQuery);
              return downloads.map((d) => ({
                id: d.id, filename: d.filename, url: d.url, state: d.state,
                bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, startTime: d.startTime,
              }));
            }
            case 'cancel': {
              await chrome.downloads.cancel(params.downloadId);
              return { success: true, cancelledDownloadId: params.downloadId };
            }
          }
        },
      }),
    };
  }
}

/**
 * Render a tool's zod schema as JSON Schema for the settings UI.
 */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  try {
    const json = z.toJSONSchema(schema as z.ZodType, { io: 'input' }) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return { type: 'object', properties: {} };
  }
}

/**
 * Flatten bookmark tree into a list for easy consumption
 */
function flattenBookmarkTree(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  depth = 0
): Array<{ id: string; title: string; url?: string; isFolder: boolean; parentId?: string; depth: number }> {
  const result: Array<{ id: string; title: string; url?: string; isFolder: boolean; parentId?: string; depth: number }> = [];
  for (const node of nodes) {
    result.push({ id: node.id, title: node.title, url: node.url, isFolder: !node.url, parentId: node.parentId, depth });
    if (node.children) {
      result.push(...flattenBookmarkTree(node.children, depth + 1));
    }
  }
  return result;
}

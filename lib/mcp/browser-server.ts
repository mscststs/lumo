import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool, WebMcpTabState } from './types';
import { WEBMCP_SESSION_KEY } from './webmcp-messages';

/**
 * Built-in Browser Core MCP Server
 * Provides tools for interacting with Chrome browser APIs:
 * - Tabs management (list, create, close, update, move, duplicate, reload, group)
 * - Windows management (list, create, close, update, resize)
 * - Bookmarks (read, create, search, delete)
 * - History (search, delete)
 * - Navigation (navigate, go back/forward, wait for load)
 * - Cookies (get, set, remove, list)
 * - Downloads (download file, list, pause, resume, cancel)
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
        // Return current tab state even on timeout
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
        // Tab might not exist
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
      description: 'Chrome browser APIs - tabs, windows, bookmarks, history, cookies, downloads, navigation',
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
    return [
      // === Tabs ===
      { name: 'browser_list_tabs', description: 'List all open tabs in the browser', inputSchema: { type: 'object', properties: { windowId: { type: 'number', description: 'Filter by window ID (optional)' } } } },
      { name: 'browser_get_active_tab', description: 'Get information about the currently active tab', inputSchema: { type: 'object', properties: {} } },
      { name: 'browser_create_tab', description: 'Create a new tab with the specified URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' } }, required: ['url'] } },
      { name: 'browser_close_tab', description: 'Close a tab by its ID', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
      { name: 'browser_update_tab', description: 'Update a tab (navigate to URL, pin, mute, etc.)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, url: { type: 'string' }, pinned: { type: 'boolean' }, muted: { type: 'boolean' }, active: { type: 'boolean' } }, required: ['tabId'] } },
      { name: 'browser_move_tab', description: 'Move a tab to a different position or window', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, windowId: { type: 'number' }, index: { type: 'number' } }, required: ['tabId', 'index'] } },
      { name: 'browser_duplicate_tab', description: 'Duplicate a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
      { name: 'browser_reload_tab', description: 'Reload a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, bypassCache: { type: 'boolean' } }, required: ['tabId'] } },
      { name: 'browser_group_tabs', description: 'Group tabs together', inputSchema: { type: 'object', properties: { tabIds: { type: 'array', items: { type: 'number' } }, title: { type: 'string' }, color: { type: 'string' } }, required: ['tabIds'] } },
      { name: 'browser_ungroup_tabs', description: 'Remove tabs from their group', inputSchema: { type: 'object', properties: { tabIds: { type: 'array', items: { type: 'number' } } }, required: ['tabIds'] } },
      // === Windows ===
      { name: 'browser_list_windows', description: 'List all browser windows', inputSchema: { type: 'object', properties: {} } },
      { name: 'browser_create_window', description: 'Create a new browser window', inputSchema: { type: 'object', properties: { url: { type: 'string' }, incognito: { type: 'boolean' }, width: { type: 'number' }, height: { type: 'number' }, left: { type: 'number' }, top: { type: 'number' } } } },
      { name: 'browser_close_window', description: 'Close a browser window', inputSchema: { type: 'object', properties: { windowId: { type: 'number' } }, required: ['windowId'] } },
      { name: 'browser_update_window', description: 'Update a window (resize, move, state)', inputSchema: { type: 'object', properties: { windowId: { type: 'number' }, state: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, left: { type: 'number' }, top: { type: 'number' } }, required: ['windowId'] } },
      // === Navigation ===
      { name: 'browser_navigate', description: 'Navigate a tab to a URL', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, url: { type: 'string' } }, required: ['url'] } },
      { name: 'browser_go_back', description: 'Go back in a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
      { name: 'browser_go_forward', description: 'Go forward in a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
      // === Bookmarks ===
      { name: 'browser_get_bookmarks', description: 'Get all bookmarks or bookmarks in a specific folder', inputSchema: { type: 'object', properties: { folderId: { type: 'string' } } } },
      { name: 'browser_search_bookmarks', description: 'Search bookmarks by title or URL', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'browser_create_bookmark', description: 'Create a new bookmark', inputSchema: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, parentId: { type: 'string' } }, required: ['title', 'url'] } },
      { name: 'browser_delete_bookmark', description: 'Delete a bookmark by its ID', inputSchema: { type: 'object', properties: { bookmarkId: { type: 'string' } }, required: ['bookmarkId'] } },
      // === History ===
      { name: 'browser_search_history', description: 'Search browser history', inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' }, startTime: { type: 'number' }, endTime: { type: 'number' } }, required: ['query'] } },
      { name: 'browser_delete_history_url', description: 'Delete a specific URL from browser history', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      // === Cookies ===
      { name: 'browser_get_cookies', description: 'Get cookies for a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url'] } },
      { name: 'browser_set_cookie', description: 'Set a cookie', inputSchema: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, domain: { type: 'string' }, path: { type: 'string' }, secure: { type: 'boolean' }, httpOnly: { type: 'boolean' }, expirationDate: { type: 'number' } }, required: ['url', 'name', 'value'] } },
      { name: 'browser_remove_cookie', description: 'Remove a cookie', inputSchema: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url', 'name'] } },
      // === Downloads ===
      { name: 'browser_download', description: 'Download a file from a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, filename: { type: 'string' }, saveAs: { type: 'boolean' } }, required: ['url'] } },
      { name: 'browser_list_downloads', description: 'List recent downloads', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'browser_cancel_download', description: 'Cancel an active download', inputSchema: { type: 'object', properties: { downloadId: { type: 'number' } }, required: ['downloadId'] } },
    ];
  }

  getAITools(): Record<string, AnyTool> {
    return {
      // ===== TABS =====
      browser_list_tabs: tool({
        description: 'List all open tabs in the browser. Returns tab ID, title, URL, active status, and window ID for each tab. If a tab has WebMCP tools registered, a webmcp field is included with tool names and descriptions.',
        inputSchema: z.object({
          windowId: z.number().optional().describe('Filter by window ID (optional)'),
        }),
        execute: async ({ windowId }) => {
          const queryInfo: chrome.tabs.QueryInfo = {};
          if (windowId !== undefined) queryInfo.windowId = windowId;
          const tabs = await chrome.tabs.query(queryInfo);

          // Load WebMCP tab states to enrich tabs with tool info
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
              return {
                ...base,
                webmcp: webmcpState.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                })),
              };
            }
            return base;
          });
        },
      }),

      browser_get_active_tab: tool({
        description: 'Get information about the currently active tab in the current window. If the tab has WebMCP tools registered, a webmcp field is included with tool names and descriptions.',
        inputSchema: z.object({}),
        execute: async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) return { error: 'No active tab found' };

          const base = {
            id: tab.id,
            title: tab.title,
            url: tab.url,
            windowId: tab.windowId,
            pinned: tab.pinned,
            index: tab.index,
          };

          // Enrich with WebMCP tools if available
          if (tab.id) {
            const webmcpStates = await this.getWebMcpTabStates();
            const tabState = webmcpStates.find((s) => s.tabId === tab.id && s.tools.length > 0);
            if (tabState) {
              return {
                ...base,
                webmcp: tabState.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                })),
              };
            }
          }

          return base;
        },
      }),

      browser_create_tab: tool({
        description: 'Create a new tab with the specified URL. Waits for the page to finish loading before returning.',
        inputSchema: z.object({
          url: z.string().describe('URL to open in the new tab'),
          active: z.boolean().optional().describe('Whether the tab should become active (default true)'),
        }),
        execute: async ({ url, active }) => {
          const tab = await chrome.tabs.create({ url, active: active !== undefined ? active : true });
          if (!tab.id) return { id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId };
          const loaded = await this.waitForTabLoad(tab.id);
          return { id: loaded.id, title: loaded.title, url: loaded.url, windowId: loaded.windowId, status: loaded.status };
        },
      }),

      browser_close_tab: tool({
        description: 'Close a tab by its ID.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to close'),
        }),
        execute: async ({ tabId }) => {
          await chrome.tabs.remove(tabId);
          return { success: true, closedTabId: tabId };
        },
      }),

      browser_update_tab: tool({
        description: 'Update a tab properties - navigate to URL, pin/unpin, mute/unmute, or activate.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to update'),
          url: z.string().optional().describe('Navigate to this URL'),
          pinned: z.boolean().optional().describe('Pin or unpin the tab'),
          muted: z.boolean().optional().describe('Mute or unmute the tab'),
          active: z.boolean().optional().describe('Activate the tab'),
        }),
        execute: async ({ tabId, url, pinned, muted, active }) => {
          const updateProps: chrome.tabs.UpdateProperties = {};
          if (url !== undefined) updateProps.url = url;
          if (pinned !== undefined) updateProps.pinned = pinned;
          if (muted !== undefined) updateProps.muted = muted;
          if (active !== undefined) updateProps.active = active;
          await chrome.tabs.update(tabId, updateProps);
          // If URL is being changed, wait for load to complete
          if (url !== undefined) {
            const loaded = await this.waitForTabLoad(tabId);
            return { id: loaded.id, title: loaded.title, url: loaded.url, pinned: loaded.pinned, active: loaded.active, muted: loaded.mutedInfo?.muted, status: loaded.status };
          }
          const tab = await chrome.tabs.get(tabId);
          return { id: tab?.id, title: tab?.title, url: tab?.url, pinned: tab?.pinned, active: tab?.active, muted: tab?.mutedInfo?.muted };
        },
      }),

      browser_move_tab: tool({
        description: 'Move a tab to a different position or window.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to move'),
          windowId: z.number().optional().describe('Target window ID (optional)'),
          index: z.number().describe('New position index'),
        }),
        execute: async ({ tabId, windowId, index }) => {
          const moveProps: chrome.tabs.MoveProperties = { index };
          if (windowId !== undefined) moveProps.windowId = windowId;
          const tab = await chrome.tabs.move(tabId, moveProps);
          const result = Array.isArray(tab) ? tab[0] : tab;
          return { id: result.id, windowId: result.windowId, index: result.index };
        },
      }),

      browser_duplicate_tab: tool({
        description: 'Duplicate a tab.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to duplicate'),
        }),
        execute: async ({ tabId }) => {
          const tab = await chrome.tabs.duplicate(tabId);
          return { id: tab?.id, title: tab?.title, url: tab?.url, windowId: tab?.windowId };
        },
      }),

      browser_reload_tab: tool({
        description: 'Reload a tab, optionally bypassing the cache. Waits for the page to finish loading.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to reload'),
          bypassCache: z.boolean().optional().describe('Bypass cache on reload (default false)'),
        }),
        execute: async ({ tabId, bypassCache }) => {
          await chrome.tabs.reload(tabId, { bypassCache: bypassCache || false });
          const loaded = await this.waitForTabLoad(tabId);
          return { success: true, reloadedTabId: tabId, url: loaded.url, title: loaded.title, status: loaded.status };
        },
      }),

      browser_group_tabs: tool({
        description: 'Group multiple tabs together into a tab group.',
        inputSchema: z.object({
          tabIds: z.array(z.number()).describe('Array of tab IDs to group'),
          title: z.string().optional().describe('Title for the tab group'),
          color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']).optional().describe('Color for the tab group'),
        }),
        execute: async ({ tabIds, title, color }) => {
          const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] });
          if (title || color) {
            await chrome.tabGroups.update(groupId as number, {
              ...(title && { title }),
              ...(color && { color }),
            });
          }
          return { success: true, groupId };
        },
      }),

      browser_ungroup_tabs: tool({
        description: 'Remove tabs from their tab group.',
        inputSchema: z.object({
          tabIds: z.array(z.number()).describe('Array of tab IDs to ungroup'),
        }),
        execute: async ({ tabIds }) => {
          await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
          return { success: true, ungroupedTabIds: tabIds };
        },
      }),

      // ===== WINDOWS =====
      browser_list_windows: tool({
        description: 'List all browser windows with their properties.',
        inputSchema: z.object({}),
        execute: async () => {
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
        },
      }),

      browser_create_window: tool({
        description: 'Create a new browser window.',
        inputSchema: z.object({
          url: z.string().optional().describe('URL to open in the new window'),
          incognito: z.boolean().optional().describe('Open in incognito mode'),
          width: z.number().optional().describe('Window width'),
          height: z.number().optional().describe('Window height'),
          left: z.number().optional().describe('Window left position'),
          top: z.number().optional().describe('Window top position'),
        }),
        execute: async ({ url, incognito, width, height, left, top }) => {
          const createData: chrome.windows.CreateData = {};
          if (url) createData.url = url;
          if (incognito !== undefined) createData.incognito = incognito;
          if (width !== undefined) createData.width = width;
          if (height !== undefined) createData.height = height;
          if (left !== undefined) createData.left = left;
          if (top !== undefined) createData.top = top;
          const win = await chrome.windows.create(createData);
          return { id: win?.id, state: win?.state, width: win?.width, height: win?.height };
        },
      }),

      browser_close_window: tool({
        description: 'Close a browser window by its ID.',
        inputSchema: z.object({
          windowId: z.number().describe('ID of the window to close'),
        }),
        execute: async ({ windowId }) => {
          await chrome.windows.remove(windowId);
          return { success: true, closedWindowId: windowId };
        },
      }),

      browser_update_window: tool({
        description: 'Update a window - resize, move, minimize, maximize, or set fullscreen.',
        inputSchema: z.object({
          windowId: z.number().describe('ID of the window to update'),
          state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']).optional().describe('Window state'),
          width: z.number().optional().describe('Window width'),
          height: z.number().optional().describe('Window height'),
          left: z.number().optional().describe('Window left position'),
          top: z.number().optional().describe('Window top position'),
          focused: z.boolean().optional().describe('Bring window to front'),
        }),
        execute: async ({ windowId, state, width, height, left, top, focused }) => {
          const updateInfo: chrome.windows.UpdateInfo = {};
          if (state) updateInfo.state = state;
          if (width !== undefined) updateInfo.width = width;
          if (height !== undefined) updateInfo.height = height;
          if (left !== undefined) updateInfo.left = left;
          if (top !== undefined) updateInfo.top = top;
          if (focused !== undefined) updateInfo.focused = focused;
          const win = await chrome.windows.update(windowId, updateInfo);
          return { id: win.id, state: win.state, width: win.width, height: win.height, left: win.left, top: win.top };
        },
      }),

      // ===== NAVIGATION =====
      browser_navigate: tool({
        description: 'Navigate a tab to a specific URL. Waits for the page to finish loading before returning the new page info. If no tabId is specified, navigates the active tab.',
        inputSchema: z.object({
          url: z.string().describe('URL to navigate to'),
          tabId: z.number().optional().describe('Tab ID to navigate (optional, defaults to active tab)'),
        }),
        execute: async ({ url, tabId }) => {
          let targetTabId = tabId;
          if (!targetTabId) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTabId = activeTab?.id;
          }
          if (!targetTabId) return { error: 'No target tab found' };
          await chrome.tabs.update(targetTabId, { url });
          const loaded = await this.waitForTabLoad(targetTabId);
          return { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status };
        },
      }),

      browser_go_back: tool({
        description: 'Navigate back in a tab\'s history. Waits for the page to finish loading.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to go back in'),
        }),
        execute: async ({ tabId }) => {
          await chrome.tabs.goBack(tabId);
          const loaded = await this.waitForTabLoad(tabId);
          return { success: true, tabId, url: loaded.url, title: loaded.title };
        },
      }),

      browser_go_forward: tool({
        description: 'Navigate forward in a tab\'s history. Waits for the page to finish loading.',
        inputSchema: z.object({
          tabId: z.number().describe('ID of the tab to go forward in'),
        }),
        execute: async ({ tabId }) => {
          await chrome.tabs.goForward(tabId);
          const loaded = await this.waitForTabLoad(tabId);
          return { success: true, tabId, url: loaded.url, title: loaded.title };
        },
      }),

      // ===== BOOKMARKS =====
      browser_get_bookmarks: tool({
        description: 'Get bookmarks tree or bookmarks in a specific folder. Returns bookmark hierarchy.',
        inputSchema: z.object({
          folderId: z.string().optional().describe('Folder ID to get bookmarks from (optional, returns full tree if omitted)'),
        }),
        execute: async ({ folderId }) => {
          if (folderId) {
            const results = await chrome.bookmarks.getChildren(folderId);
            return results.map((node) => ({
              id: node.id, title: node.title, url: node.url, isFolder: !node.url, parentId: node.parentId,
            }));
          }
          const tree = await chrome.bookmarks.getTree();
          return flattenBookmarkTree(tree);
        },
      }),

      browser_search_bookmarks: tool({
        description: 'Search bookmarks by title or URL keyword.',
        inputSchema: z.object({
          query: z.string().describe('Search query string'),
        }),
        execute: async ({ query }) => {
          const results = await chrome.bookmarks.search(query);
          return results.map((node) => ({
            id: node.id, title: node.title, url: node.url, parentId: node.parentId,
          }));
        },
      }),

      browser_create_bookmark: tool({
        description: 'Create a new bookmark with the specified title and URL.',
        inputSchema: z.object({
          title: z.string().describe('Bookmark title'),
          url: z.string().describe('Bookmark URL'),
          parentId: z.string().optional().describe('Parent folder ID (optional, defaults to "Other Bookmarks")'),
        }),
        execute: async ({ title, url, parentId }) => {
          const bookmark = await chrome.bookmarks.create({ title, url, parentId });
          return { id: bookmark.id, title: bookmark.title, url: bookmark.url, parentId: bookmark.parentId };
        },
      }),

      browser_delete_bookmark: tool({
        description: 'Delete a bookmark by its ID.',
        inputSchema: z.object({
          bookmarkId: z.string().describe('ID of the bookmark to delete'),
        }),
        execute: async ({ bookmarkId }) => {
          await chrome.bookmarks.remove(bookmarkId);
          return { success: true, deletedId: bookmarkId };
        },
      }),

      // ===== HISTORY =====
      browser_search_history: tool({
        description: 'Search browser history by query string. Returns visited URLs with visit count and last visit time.',
        inputSchema: z.object({
          query: z.string().describe('Search query string'),
          maxResults: z.number().optional().describe('Maximum number of results (default 20)'),
          startTime: z.number().optional().describe('Start time as milliseconds since epoch (optional)'),
          endTime: z.number().optional().describe('End time as milliseconds since epoch (optional)'),
        }),
        execute: async ({ query, maxResults, startTime, endTime }) => {
          const searchParams: chrome.history.HistoryQuery = { text: query, maxResults: maxResults || 20 };
          if (startTime !== undefined) searchParams.startTime = startTime;
          if (endTime !== undefined) searchParams.endTime = endTime;
          const results = await chrome.history.search(searchParams);
          return results.map((item) => ({
            url: item.url, title: item.title, visitCount: item.visitCount, lastVisitTime: item.lastVisitTime,
          }));
        },
      }),

      browser_delete_history_url: tool({
        description: 'Delete a specific URL from browser history.',
        inputSchema: z.object({
          url: z.string().describe('URL to delete from history'),
        }),
        execute: async ({ url }) => {
          await chrome.history.deleteUrl({ url });
          return { success: true, deletedUrl: url };
        },
      }),

      // ===== COOKIES =====
      browser_get_cookies: tool({
        description: 'Get cookies for a specific URL. Optionally filter by name.',
        inputSchema: z.object({
          url: z.string().describe('URL to get cookies for'),
          name: z.string().optional().describe('Filter by cookie name (optional)'),
        }),
        execute: async ({ url, name }) => {
          if (name) {
            const cookie = await chrome.cookies.get({ url, name });
            return cookie ? [cookie] : [];
          }
          const cookies = await chrome.cookies.getAll({ url });
          return cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
            sameSite: c.sameSite,
          }));
        },
      }),

      browser_set_cookie: tool({
        description: 'Set a cookie for a URL.',
        inputSchema: z.object({
          url: z.string().describe('URL to set the cookie for'),
          name: z.string().describe('Cookie name'),
          value: z.string().describe('Cookie value'),
          domain: z.string().optional().describe('Cookie domain'),
          path: z.string().optional().describe('Cookie path'),
          secure: z.boolean().optional().describe('Whether the cookie is secure'),
          httpOnly: z.boolean().optional().describe('Whether the cookie is HTTP only'),
          expirationDate: z.number().optional().describe('Cookie expiration as seconds since epoch'),
          sameSite: z.enum(['no_restriction', 'lax', 'strict']).optional().describe('SameSite attribute'),
        }),
        execute: async ({ url, name, value, domain, path, secure, httpOnly, expirationDate, sameSite }) => {
          const details: chrome.cookies.SetDetails = { url, name, value };
          if (domain) details.domain = domain;
          if (path) details.path = path;
          if (secure !== undefined) details.secure = secure;
          if (httpOnly !== undefined) details.httpOnly = httpOnly;
          if (expirationDate !== undefined) details.expirationDate = expirationDate;
          if (sameSite) details.sameSite = sameSite;
          const cookie = await chrome.cookies.set(details);
          return cookie ? { success: true, name: cookie.name, domain: cookie.domain } : { error: 'Failed to set cookie' };
        },
      }),

      browser_remove_cookie: tool({
        description: 'Remove a cookie by URL and name.',
        inputSchema: z.object({
          url: z.string().describe('URL the cookie belongs to'),
          name: z.string().describe('Name of the cookie to remove'),
        }),
        execute: async ({ url, name }) => {
          await chrome.cookies.remove({ url, name });
          return { success: true, removedCookie: name };
        },
      }),

      // ===== DOWNLOADS =====
      browser_download: tool({
        description: 'Download a file from a URL.',
        inputSchema: z.object({
          url: z.string().describe('URL of the file to download'),
          filename: z.string().optional().describe('Suggested filename for the download'),
          saveAs: z.boolean().optional().describe('Show "Save As" dialog (default false)'),
        }),
        execute: async ({ url, filename, saveAs }) => {
          const options: chrome.downloads.DownloadOptions = { url };
          if (filename) options.filename = filename;
          if (saveAs !== undefined) options.saveAs = saveAs;
          const downloadId = await chrome.downloads.download(options);
          return { success: true, downloadId };
        },
      }),

      browser_list_downloads: tool({
        description: 'Search and list recent downloads.',
        inputSchema: z.object({
          query: z.string().optional().describe('Search query to filter downloads'),
          limit: z.number().optional().describe('Maximum number of results (default 20)'),
        }),
        execute: async ({ query, limit }) => {
          const searchQuery: chrome.downloads.DownloadQuery = {};
          if (query) searchQuery.filenameRegex = query;
          searchQuery.limit = limit || 20;
          const downloads = await chrome.downloads.search(searchQuery);
          return downloads.map((d) => ({
            id: d.id,
            filename: d.filename,
            url: d.url,
            state: d.state,
            bytesReceived: d.bytesReceived,
            totalBytes: d.totalBytes,
            startTime: d.startTime,
          }));
        },
      }),

      browser_cancel_download: tool({
        description: 'Cancel an active download.',
        inputSchema: z.object({
          downloadId: z.number().describe('ID of the download to cancel'),
        }),
        execute: async ({ downloadId }) => {
          await chrome.downloads.cancel(downloadId);
          return { success: true, cancelledDownloadId: downloadId };
        },
      }),
    };
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

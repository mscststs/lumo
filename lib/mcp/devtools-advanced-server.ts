import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool } from './types';
import { consoleLog, attachedTabs } from './session-store';

/**
 * DevTools Advanced MCP Server
 * Provides advanced browser debugging capabilities via chrome.debugger API (CDP):
 * - Real input simulation (mouse, keyboard, drag-and-drop)
 * - Accessibility tree inspection
 * - Full-page screenshots (beyond viewport)
 * - Element-level screenshots
 * - Network interception with response body access
 * - Device/network/geolocation emulation
 * - CPU throttling
 * - Console message collection
 * - JavaScript evaluation in isolated contexts
 *
 * CDP event collection lives in `collectors.ts` and only runs in the background
 * service worker. Debugger attachment is per-extension rather than per-context,
 * so the attached-tab set is shared through session storage instead of being
 * held on the instance.
 */
export class DevToolsAdvancedMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'devtools-advanced',
      name: 'DevTools Advanced',
      description: 'Advanced debugging: real input simulation, accessibility tree, full-page screenshots, network interception, device emulation',
      transport: 'builtin',
      builtin: true,
      enabled: true,
      icon: 'bug',
    };
  }

  async connect(): Promise<void> {
    try {
      this.status = 'connecting';
      if (typeof chrome === 'undefined' || !chrome.debugger) {
        throw new Error('Chrome debugger API not available');
      }
      this.status = 'connected';
      this.error = undefined;
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async disconnect(): Promise<void> {
    // Detach everywhere: a debugger attachment shows an infobar on the tab and
    // is extension-global, so leaving it behind is user-visible.
    for (const tabId of await attachedTabs.read()) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Tab may already be closed, or never attached in this session.
      }
    }
    await attachedTabs.clear();
    this.status = 'disconnected';
  }

  getStatus(): McpServerStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.error;
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (await attachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      // Another context (or an earlier service worker) may have attached
      // already without the shared set reflecting it yet.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Another debugger') && !message.includes('already attached')) {
        throw error;
      }
    }
    await attachedTabs.add(tabId);
    // Enable Runtime so the background collector receives console events.
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  }

  private async getTargetTabId(tabId?: number): Promise<number> {
    if (tabId) return tabId;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error('No active tab found');
    return activeTab.id;
  }

  private async sendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureAttached(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  getTools(): McpToolDefinition[] {
    return [
      { name: 'debug_attach', description: 'Attach the debugger to a tab (required before other debug tools)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
      { name: 'debug_detach', description: 'Detach the debugger from a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
      { name: 'debug_real_click', description: 'Simulate a real mouse click at coordinates using CDP Input', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, clickCount: { type: 'number' }, tabId: { type: 'number' } }, required: ['x', 'y'] } },
      { name: 'debug_real_type', description: 'Type text using real keyboard events via CDP', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
      { name: 'debug_real_press_key', description: 'Press a specific key using CDP Input domain', inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'number' }, tabId: { type: 'number' } }, required: ['key'] } },
      { name: 'debug_drag_drop', description: 'Perform a drag and drop operation between two coordinates', inputSchema: { type: 'object', properties: { startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, tabId: { type: 'number' } }, required: ['startX', 'startY', 'endX', 'endY'] } },
      { name: 'debug_get_accessibility_tree', description: 'Get the full accessibility tree of the page', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
      { name: 'debug_full_page_screenshot', description: 'Take a full-page screenshot (beyond viewport)', inputSchema: { type: 'object', properties: { format: { type: 'string' }, quality: { type: 'number' }, tabId: { type: 'number' } } } },
      { name: 'debug_element_screenshot', description: 'Take a screenshot of a specific element by selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'debug_emulate_device', description: 'Emulate a device viewport (mobile, tablet, etc.)', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, deviceScaleFactor: { type: 'number' }, mobile: { type: 'boolean' }, userAgent: { type: 'string' }, tabId: { type: 'number' } }, required: ['width', 'height'] } },
      { name: 'debug_emulate_network', description: 'Emulate network conditions (offline, slow 3G, etc.)', inputSchema: { type: 'object', properties: { offline: { type: 'boolean' }, latency: { type: 'number' }, downloadThroughput: { type: 'number' }, uploadThroughput: { type: 'number' }, tabId: { type: 'number' } } } },
      { name: 'debug_emulate_geolocation', description: 'Override geolocation coordinates', inputSchema: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' }, tabId: { type: 'number' } }, required: ['latitude', 'longitude'] } },
      { name: 'debug_cpu_throttle', description: 'Set CPU throttling rate', inputSchema: { type: 'object', properties: { rate: { type: 'number' }, tabId: { type: 'number' } }, required: ['rate'] } },
      { name: 'debug_list_console_messages', description: 'List collected console messages from attached tabs', inputSchema: { type: 'object', properties: { level: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'debug_emulate_media', description: 'Emulate CSS media features (dark mode, reduced motion, etc.)', inputSchema: { type: 'object', properties: { colorScheme: { type: 'string' }, reducedMotion: { type: 'string' }, forcedColors: { type: 'string' }, tabId: { type: 'number' } } } },
    ];
  }

  getAITools(): Record<string, AnyTool> {
    return {
      debug_attach: tool({
        description: 'Attach the debugger to a tab. This is required before using other debug tools. Shows a "debugging" infobar on the tab.',
        inputSchema: z.object({
          tabId: z.number().optional().describe('Tab ID to attach to (optional, defaults to active tab)'),
        }),
        execute: async ({ tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          await this.ensureAttached(targetTabId);
          return { success: true, tabId: targetTabId, message: 'Debugger attached successfully' };
        },
      }),

      debug_detach: tool({
        description: 'Detach the debugger from a tab, removing the "debugging" infobar.',
        inputSchema: z.object({
          tabId: z.number().describe('Tab ID to detach from'),
        }),
        execute: async ({ tabId }) => {
          if (await attachedTabs.has(tabId)) {
            await chrome.debugger.detach({ tabId });
            await attachedTabs.remove(tabId);
          }
          return { success: true, tabId };
        },
      }),

      debug_real_click: tool({
        description: 'Simulate a real mouse click at specific coordinates using the CDP Input domain. This produces OS-level input events that are indistinguishable from real user input.',
        inputSchema: z.object({
          x: z.number().describe('X coordinate'),
          y: z.number().describe('Y coordinate'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
          clickCount: z.number().optional().describe('Number of clicks (default 1, use 2 for double-click)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ x, y, button, clickCount, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const btn = button || 'left';
          const count = clickCount || 1;
          // Mouse down
          await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x, y,
            button: btn,
            clickCount: count,
          });
          // Mouse up
          await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x, y,
            button: btn,
            clickCount: count,
          });
          return { success: true, x, y, button: btn, clickCount: count };
        },
      }),

      debug_real_type: tool({
        description: 'Type text using real keyboard events via CDP Input domain. Each character generates proper keyDown/keyUp events. Works with any focused input.',
        inputSchema: z.object({
          text: z.string().describe('Text to type'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ text, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          for (const char of text) {
            await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: char,
              key: char,
              unmodifiedText: char,
            });
            await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              text: char,
              key: char,
              unmodifiedText: char,
            });
          }
          return { success: true, typed: text, length: text.length };
        },
      }),

      debug_real_press_key: tool({
        description: 'Press a specific key using CDP Input domain. Supports modifier keys (Ctrl, Alt, Shift, Meta).',
        inputSchema: z.object({
          key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "a", "ArrowDown")'),
          modifiers: z.number().optional().describe('Bit field: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ key, modifiers, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const keyCode = this.getKeyCode(key);
          await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code: keyCode.code,
            windowsVirtualKeyCode: keyCode.keyCode,
            modifiers: modifiers || 0,
          });
          await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code: keyCode.code,
            windowsVirtualKeyCode: keyCode.keyCode,
            modifiers: modifiers || 0,
          });
          return { success: true, key, modifiers: modifiers || 0 };
        },
      }),

      debug_drag_drop: tool({
        description: 'Perform a drag and drop operation between two coordinates using CDP mouse events.',
        inputSchema: z.object({
          startX: z.number().describe('Start X coordinate'),
          startY: z.number().describe('Start Y coordinate'),
          endX: z.number().describe('End X coordinate'),
          endY: z.number().describe('End Y coordinate'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ startX, startY, endX, endY, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          // Mouse down at start
          await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: startX, y: startY,
            button: 'left',
            clickCount: 1,
          });
          // Move to end (with intermediate steps for smooth drag)
          const steps = 10;
          for (let i = 1; i <= steps; i++) {
            const x = startX + (endX - startX) * (i / steps);
            const y = startY + (endY - startY) * (i / steps);
            await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x, y,
              button: 'left',
            });
          }
          // Mouse up at end
          await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: endX, y: endY,
            button: 'left',
            clickCount: 1,
          });
          return { success: true, from: { x: startX, y: startY }, to: { x: endX, y: endY } };
        },
      }),

      debug_get_accessibility_tree: tool({
        description: 'Get the full accessibility tree of the page. Returns nodes with role, name, value, and children. Useful for understanding page structure from an a11y perspective.',
        inputSchema: z.object({
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          await this.sendCommand(targetTabId, 'Accessibility.enable');
          const result = await this.sendCommand(targetTabId, 'Accessibility.getFullAXTree') as { nodes: Array<{
            nodeId: string;
            role?: { value: string };
            name?: { value: string };
            value?: { value: string };
            properties?: Array<{ name: string; value: { value: unknown } }>;
            childIds?: string[];
            ignored?: boolean;
          }> };
          // Simplify the tree for AI consumption
          const nodes = (result.nodes || [])
            .filter(n => !n.ignored)
            .slice(0, 200)
            .map(n => ({
              nodeId: n.nodeId,
              role: n.role?.value,
              name: n.name?.value,
              value: n.value?.value,
              properties: n.properties?.reduce((acc, p) => {
                acc[p.name] = p.value?.value;
                return acc;
              }, {} as Record<string, unknown>),
              childIds: n.childIds,
            }));
          return { totalNodes: result.nodes?.length || 0, returnedNodes: nodes.length, nodes };
        },
      }),

      debug_full_page_screenshot: tool({
        description: 'Take a full-page screenshot that captures content beyond the visible viewport. Returns base64-encoded image.',
        inputSchema: z.object({
          format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Image format (default png)'),
          quality: z.number().optional().describe('Image quality 0-100 (for jpeg/webp)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ format, quality, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          // Get page dimensions
          const layoutMetrics = await this.sendCommand(targetTabId, 'Page.getLayoutMetrics') as {
            contentSize: { width: number; height: number };
          };
          const { width, height } = layoutMetrics.contentSize;
          // Capture full page
          const result = await this.sendCommand(targetTabId, 'Page.captureScreenshot', {
            format: format || 'png',
            quality: quality || undefined,
            clip: { x: 0, y: 0, width, height, scale: 1 },
            captureBeyondViewport: true,
          }) as { data: string };
          return {
            content: [
              { type: 'image', data: result.data, mimeType: `image/${format || 'png'}` },
              {
                type: 'text',
                text: `Full-page screenshot captured (${format || 'png'}, ${width}x${height})`,
              },
            ],
            isError: false,
          };
        },
      }),

      debug_element_screenshot: tool({
        description: 'Take a screenshot of a specific element identified by CSS selector.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the element to screenshot'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          // Get element bounds via Runtime.evaluate
          const boundsResult = await this.sendCommand(targetTabId, 'Runtime.evaluate', {
            expression: `(() => { const el = document.querySelector('${selector.replace(/'/g, "\\'")}'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
            returnByValue: true,
          }) as { result: { value: { x: number; y: number; width: number; height: number } | null } };
          const bounds = boundsResult.result?.value;
          if (!bounds) return { error: `Element not found: ${selector}` };
          // Capture screenshot of the element area
          const result = await this.sendCommand(targetTabId, 'Page.captureScreenshot', {
            format: 'png',
            clip: { ...bounds, scale: 1 },
          }) as { data: string };
          return {
            content: [
              { type: 'image', data: result.data, mimeType: 'image/png' },
              {
                type: 'text',
                text: `Element screenshot captured (${selector}, ${Math.round(bounds.width)}x${Math.round(bounds.height)})`,
              },
            ],
            isError: false,
          };
        },
      }),

      debug_emulate_device: tool({
        description: 'Emulate a device viewport with custom dimensions, scale factor, and user agent. Useful for testing responsive layouts.',
        inputSchema: z.object({
          width: z.number().describe('Viewport width in pixels'),
          height: z.number().describe('Viewport height in pixels'),
          deviceScaleFactor: z.number().optional().describe('Device scale factor (default 1)'),
          mobile: z.boolean().optional().describe('Whether to emulate a mobile device (default false)'),
          userAgent: z.string().optional().describe('Custom user agent string'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ width, height, deviceScaleFactor, mobile, userAgent, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          await this.sendCommand(targetTabId, 'Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: deviceScaleFactor || 1,
            mobile: mobile || false,
          });
          if (userAgent) {
            await this.sendCommand(targetTabId, 'Network.setUserAgentOverride', {
              userAgent,
            });
          }
          return { success: true, viewport: { width, height, deviceScaleFactor: deviceScaleFactor || 1, mobile: mobile || false }, userAgent };
        },
      }),

      debug_emulate_network: tool({
        description: 'Emulate network conditions like offline mode, slow 3G, etc. Set all values to -1 to disable throttling.',
        inputSchema: z.object({
          offline: z.boolean().optional().describe('Simulate offline (default false)'),
          latency: z.number().optional().describe('Additional latency in ms (default 0)'),
          downloadThroughput: z.number().optional().describe('Max download speed in bytes/s (-1 for unlimited)'),
          uploadThroughput: z.number().optional().describe('Max upload speed in bytes/s (-1 for unlimited)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ offline, latency, downloadThroughput, uploadThroughput, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          await this.sendCommand(targetTabId, 'Network.enable');
          await this.sendCommand(targetTabId, 'Network.emulateNetworkConditions', {
            offline: offline || false,
            latency: latency || 0,
            downloadThroughput: downloadThroughput ?? -1,
            uploadThroughput: uploadThroughput ?? -1,
          });
          return {
            success: true,
            conditions: { offline: offline || false, latency: latency || 0, downloadThroughput: downloadThroughput ?? -1, uploadThroughput: uploadThroughput ?? -1 },
          };
        },
      }),

      debug_emulate_geolocation: tool({
        description: 'Override the browser\'s geolocation to specified coordinates.',
        inputSchema: z.object({
          latitude: z.number().describe('Latitude (-90 to 90)'),
          longitude: z.number().describe('Longitude (-180 to 180)'),
          accuracy: z.number().optional().describe('Position accuracy in meters (default 1)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ latitude, longitude, accuracy, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          await this.sendCommand(targetTabId, 'Emulation.setGeolocationOverride', {
            latitude,
            longitude,
            accuracy: accuracy || 1,
          });
          return { success: true, location: { latitude, longitude, accuracy: accuracy || 1 } };
        },
      }),

      debug_cpu_throttle: tool({
        description: 'Set CPU throttling rate. 1 means no throttling, 2 means 2x slowdown, 4 means 4x slowdown, etc.',
        inputSchema: z.object({
          rate: z.number().describe('Throttling rate (1 = normal, 2 = 2x slower, 4 = 4x slower, etc.)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ rate, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          await this.sendCommand(targetTabId, 'Emulation.setCPUThrottlingRate', { rate });
          return { success: true, rate };
        },
      }),

      debug_list_console_messages: tool({
        description: 'List console messages and uncaught exceptions collected from attached tabs. Collection runs in the background for as long as the debugger stays attached, so messages persist even if the side panel was closed. Attach with debug_attach first.',
        inputSchema: z.object({
          level: z.enum(['log', 'info', 'warning', 'error', 'debug']).optional().describe('Filter by log level'),
          limit: z.number().optional().describe('Maximum number of messages to return (default 50)'),
        }),
        execute: async ({ level, limit }) => {
          let messages = await consoleLog.read();
          if (level) messages = messages.filter(m => m.level === level);
          const maxResults = limit || 50;
          const results = messages.slice(-maxResults).reverse();
          return { total: messages.length, returned: results.length, messages: results };
        },
      }),

      debug_emulate_media: tool({
        description: 'Emulate CSS media features like prefers-color-scheme (dark/light mode), prefers-reduced-motion, and forced-colors.',
        inputSchema: z.object({
          colorScheme: z.enum(['light', 'dark']).optional().describe('Emulate prefers-color-scheme'),
          reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('Emulate prefers-reduced-motion'),
          forcedColors: z.enum(['active', 'none']).optional().describe('Emulate forced-colors'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ colorScheme, reducedMotion, forcedColors, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const features: Array<{ name: string; value: string }> = [];
          if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
          if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
          if (forcedColors) features.push({ name: 'forced-colors', value: forcedColors });
          await this.sendCommand(targetTabId, 'Emulation.setEmulatedMedia', {
            features,
          });
          return { success: true, emulatedFeatures: features };
        },
      }),
    };
  }

  private getKeyCode(key: string): { code: string; keyCode: number } {
    const keyMap: Record<string, { code: string; keyCode: number }> = {
      'Enter': { code: 'Enter', keyCode: 13 },
      'Tab': { code: 'Tab', keyCode: 9 },
      'Escape': { code: 'Escape', keyCode: 27 },
      'Space': { code: 'Space', keyCode: 32 },
      'Backspace': { code: 'Backspace', keyCode: 8 },
      'Delete': { code: 'Delete', keyCode: 46 },
      'ArrowUp': { code: 'ArrowUp', keyCode: 38 },
      'ArrowDown': { code: 'ArrowDown', keyCode: 40 },
      'ArrowLeft': { code: 'ArrowLeft', keyCode: 37 },
      'ArrowRight': { code: 'ArrowRight', keyCode: 39 },
      'Home': { code: 'Home', keyCode: 36 },
      'End': { code: 'End', keyCode: 35 },
      'PageUp': { code: 'PageUp', keyCode: 33 },
      'PageDown': { code: 'PageDown', keyCode: 34 },
      'F1': { code: 'F1', keyCode: 112 },
      'F2': { code: 'F2', keyCode: 113 },
      'F3': { code: 'F3', keyCode: 114 },
      'F4': { code: 'F4', keyCode: 115 },
      'F5': { code: 'F5', keyCode: 116 },
      'F6': { code: 'F6', keyCode: 117 },
      'F7': { code: 'F7', keyCode: 118 },
      'F8': { code: 'F8', keyCode: 119 },
      'F9': { code: 'F9', keyCode: 120 },
      'F10': { code: 'F10', keyCode: 121 },
      'F11': { code: 'F11', keyCode: 122 },
      'F12': { code: 'F12', keyCode: 123 },
    };
    if (keyMap[key]) return keyMap[key];
    // Single character
    if (key.length === 1) {
      return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
    }
    return { code: key, keyCode: 0 };
  }
}

import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool } from './types';
import { consoleLog, attachedTabs } from './session-store';

/**
 * DevTools Advanced MCP Server
 * Provides 4 unified tools for advanced browser debugging via chrome.debugger API (CDP):
 * - debug_session: Attach/detach the debugger
 * - debug_input: Real input simulation (mouse click, keyboard type/press, drag-and-drop)
 * - debug_emulate: Device, network, geolocation, media, and CPU emulation
 * - debug_console: Console message collection
 */
export class DevToolsAdvancedMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'devtools-advanced',
      name: 'DevTools Advanced',
      description: 'Advanced debugging: real input simulation, device/network/geolocation emulation, console messages',
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
    for (const tabId of await attachedTabs.read()) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Tab may already be closed.
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
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Another debugger') && !message.includes('already attached')) {
        throw error;
      }
    }
    await attachedTabs.add(tabId);
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
    return Object.entries(this.getAITools()).map(([name, definition]) => ({
      name,
      description: (definition as { description?: string }).description ?? '',
      inputSchema: toJsonSchema((definition as { inputSchema?: unknown }).inputSchema),
    }));
  }

  getAITools(): Record<string, AnyTool> {
    return {
      debug_session: tool({
        description:
          'Manage debugger attachment. Actions: attach (attach debugger to a tab, shows "debugging" infobar), ' +
          'detach (detach debugger, removes infobar). Attaching is required before debug_input or debug_emulate.',
        inputSchema: z.object({
          action: z.enum(['attach', 'detach']).describe('The action to perform'),
          tabId: z.number().optional().describe('[attach] Tab ID to attach to (defaults to active tab); [detach] Tab ID to detach from'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'attach': {
              const targetTabId = await this.getTargetTabId(params.tabId);
              await this.ensureAttached(targetTabId);
              return { success: true, tabId: targetTabId, message: 'Debugger attached successfully' };
            }
            case 'detach': {
              if (await attachedTabs.has(params.tabId)) {
                await chrome.debugger.detach({ tabId: params.tabId });
                await attachedTabs.remove(params.tabId);
              }
              return { success: true, tabId: params.tabId };
            }
          }
        },
      }),

      debug_input: tool({
        description:
          'Simulate real user input via CDP Input domain. Actions: ' +
          'click (mouse click at coordinates, indistinguishable from real user input), ' +
          'type (type text using real keyboard events), ' +
          'key (press a specific key with optional modifiers), ' +
          'drag (drag and drop between two coordinates). ' +
          'Auto-attaches debugger if needed.',
        inputSchema: z.object({
          action: z.enum(['click', 'type', 'key', 'drag']).describe('The input action to perform'),
          x: z.number().optional().describe('[click] X coordinate'),
          y: z.number().optional().describe('[click] Y coordinate'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('[click] Mouse button (default left)'),
          clickCount: z.number().optional().describe('[click] Number of clicks (1=single, 2=double)'),
          text: z.string().optional().describe('[type] Text to type'),
          key: z.string().optional().describe('[key] Key to press (e.g., "Enter", "Tab", "Escape", "a", "ArrowDown")'),
          modifiers: z.number().optional().describe('[key] Bit field: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift'),
          startX: z.number().optional().describe('[drag] Start X coordinate'),
          startY: z.number().optional().describe('[drag] Start Y coordinate'),
          endX: z.number().optional().describe('[drag] End X coordinate'),
          endY: z.number().optional().describe('[drag] End Y coordinate'),
          tabId: z.number().optional().describe('Tab ID (defaults to active tab)'),
        }),
        execute: async (params: any) => {
          const targetTabId = await this.getTargetTabId(params.tabId);
          switch (params.action) {
            case 'click': {
              const btn = params.button || 'left';
              const count = params.clickCount || 1;
              await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed', x: params.x, y: params.y, button: btn, clickCount: count,
              });
              await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: params.x, y: params.y, button: btn, clickCount: count,
              });
              return { success: true, x: params.x, y: params.y, button: btn, clickCount: count };
            }
            case 'type': {
              for (const char of params.text) {
                await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
                  type: 'keyDown', text: char, key: char, unmodifiedText: char,
                });
                await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
                  type: 'keyUp', text: char, key: char, unmodifiedText: char,
                });
              }
              return { success: true, typed: params.text, length: params.text.length };
            }
            case 'key': {
              const keyCode = this.getKeyCode(params.key);
              await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
                type: 'keyDown', key: params.key, code: keyCode.code,
                windowsVirtualKeyCode: keyCode.keyCode, modifiers: params.modifiers || 0,
              });
              await this.sendCommand(targetTabId, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: params.key, code: keyCode.code,
                windowsVirtualKeyCode: keyCode.keyCode, modifiers: params.modifiers || 0,
              });
              return { success: true, key: params.key, modifiers: params.modifiers || 0 };
            }
            case 'drag': {
              await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed', x: params.startX, y: params.startY, button: 'left', clickCount: 1,
              });
              const steps = 10;
              for (let i = 1; i <= steps; i++) {
                const x = params.startX + (params.endX - params.startX) * (i / steps);
                const y = params.startY + (params.endY - params.startY) * (i / steps);
                await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
                  type: 'mouseMoved', x, y, button: 'left',
                });
              }
              await this.sendCommand(targetTabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: params.endX, y: params.endY, button: 'left', clickCount: 1,
              });
              return { success: true, from: { x: params.startX, y: params.startY }, to: { x: params.endX, y: params.endY } };
            }
          }
        },
      }),

      debug_emulate: tool({
        description:
          'Emulate browser conditions. Targets: ' +
          'device (viewport size, scale, mobile flag, user agent), ' +
          'network (offline, latency, throughput), ' +
          'geolocation (latitude, longitude, accuracy), ' +
          'media (prefers-color-scheme, prefers-reduced-motion, forced-colors), ' +
          'cpu (throttling rate). Auto-attaches debugger if needed.',
        inputSchema: z.object({
          target: z.enum(['device', 'network', 'geolocation', 'media', 'cpu']).describe('The emulation target'),
          width: z.number().optional().describe('[device] Viewport width in pixels'),
          height: z.number().optional().describe('[device] Viewport height in pixels'),
          deviceScaleFactor: z.number().optional().describe('[device] Device scale factor (default 1)'),
          mobile: z.boolean().optional().describe('[device] Emulate mobile (default false)'),
          userAgent: z.string().optional().describe('[device] Custom user agent string'),
          offline: z.boolean().optional().describe('[network] Simulate offline (default false)'),
          latency: z.number().optional().describe('[network] Additional latency in ms (default 0)'),
          downloadThroughput: z.number().optional().describe('[network] Max download bytes/s (-1 unlimited)'),
          uploadThroughput: z.number().optional().describe('[network] Max upload bytes/s (-1 unlimited)'),
          latitude: z.number().optional().describe('[geolocation] Latitude (-90 to 90)'),
          longitude: z.number().optional().describe('[geolocation] Longitude (-180 to 180)'),
          accuracy: z.number().optional().describe('[geolocation] Position accuracy in meters (default 1)'),
          colorScheme: z.enum(['light', 'dark']).optional().describe('[media] Emulate prefers-color-scheme'),
          reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('[media] Emulate prefers-reduced-motion'),
          forcedColors: z.enum(['active', 'none']).optional().describe('[media] Emulate forced-colors'),
          rate: z.number().optional().describe('[cpu] Throttling rate (1=normal, 2=2x slower, 4=4x slower)'),
          tabId: z.number().optional().describe('Tab ID (defaults to active tab)'),
        }),
        execute: async (params: any) => {
          const targetTabId = await this.getTargetTabId(params.tabId);
          switch (params.target) {
            case 'device': {
              await this.sendCommand(targetTabId, 'Emulation.setDeviceMetricsOverride', {
                width: params.width,
                height: params.height,
                deviceScaleFactor: params.deviceScaleFactor || 1,
                mobile: params.mobile || false,
              });
              if (params.userAgent) {
                await this.sendCommand(targetTabId, 'Network.setUserAgentOverride', { userAgent: params.userAgent });
              }
              return { success: true, viewport: { width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor || 1, mobile: params.mobile || false }, userAgent: params.userAgent };
            }
            case 'network': {
              await this.sendCommand(targetTabId, 'Network.enable');
              await this.sendCommand(targetTabId, 'Network.emulateNetworkConditions', {
                offline: params.offline || false,
                latency: params.latency || 0,
                downloadThroughput: params.downloadThroughput ?? -1,
                uploadThroughput: params.uploadThroughput ?? -1,
              });
              return { success: true, conditions: { offline: params.offline || false, latency: params.latency || 0, downloadThroughput: params.downloadThroughput ?? -1, uploadThroughput: params.uploadThroughput ?? -1 } };
            }
            case 'geolocation': {
              await this.sendCommand(targetTabId, 'Emulation.setGeolocationOverride', {
                latitude: params.latitude,
                longitude: params.longitude,
                accuracy: params.accuracy || 1,
              });
              return { success: true, location: { latitude: params.latitude, longitude: params.longitude, accuracy: params.accuracy || 1 } };
            }
            case 'media': {
              const features: Array<{ name: string; value: string }> = [];
              if (params.colorScheme) features.push({ name: 'prefers-color-scheme', value: params.colorScheme });
              if (params.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: params.reducedMotion });
              if (params.forcedColors) features.push({ name: 'forced-colors', value: params.forcedColors });
              await this.sendCommand(targetTabId, 'Emulation.setEmulatedMedia', { features });
              return { success: true, emulatedFeatures: features };
            }
            case 'cpu': {
              await this.sendCommand(targetTabId, 'Emulation.setCPUThrottlingRate', { rate: params.rate });
              return { success: true, rate: params.rate };
            }
          }
        },
      }),

      debug_console: tool({
        description:
          'List console messages and uncaught exceptions collected from attached tabs. ' +
          'Collection runs in the background for as long as the debugger stays attached. ' +
          'Attach with debug_session first.',
        inputSchema: z.object({
          level: z.enum(['log', 'info', 'warning', 'error', 'debug']).optional().describe('Filter by log level'),
          limit: z.number().optional().describe('Maximum messages to return (default 50)'),
        }),
        execute: async ({ level, limit }) => {
          let messages = await consoleLog.read();
          if (level) messages = messages.filter(m => m.level === level);
          const maxResults = limit || 50;
          const results = messages.slice(-maxResults).reverse();
          return { total: messages.length, returned: results.length, messages: results };
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
    if (key.length === 1) {
      return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
    }
    return { code: key, keyCode: 0 };
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

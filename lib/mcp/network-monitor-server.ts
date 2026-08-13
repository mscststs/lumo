import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool } from './types';
import { networkLog } from './session-store';

/**
 * Network Monitor MCP Server
 * Provides 2 unified tools for monitoring and controlling network activity:
 * - network_requests: List/filter/get/clear captured network requests
 * - network_rules: Block, redirect, modify headers, list/clear rules
 */
export class NetworkMonitorMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'network-monitor',
      name: 'Network Monitor',
      description: 'Network request monitoring, URL blocking, redirects, and header modification',
      transport: 'builtin',
      builtin: true,
      enabled: true,
      icon: 'network',
    };
  }

  async connect(): Promise<void> {
    try {
      this.status = 'connecting';
      if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest) {
        throw new Error('Chrome declarativeNetRequest API not available');
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

  private getNextRuleId(): number {
    return Date.now() % 1000000;
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
      network_requests: tool({
        description:
          'Monitor network requests. Actions: list (filter by URL, method, type, status), ' +
          'get (detailed info for a specific request by ID), clear (clear all captured requests).',
        inputSchema: z.object({
          action: z.enum(['list', 'get', 'clear']).describe('The action to perform'),
          urlFilter: z.string().optional().describe('[list] Filter by URL substring'),
          method: z.string().optional().describe('[list] Filter by HTTP method (GET, POST, etc.)'),
          type: z.string().optional().describe('[list] Filter by resource type (main_frame, script, xmlhttprequest, etc.)'),
          statusCode: z.number().optional().describe('[list] Filter by HTTP status code'),
          limit: z.number().optional().describe('[list] Maximum results (default 50)'),
          requestId: z.string().optional().describe('[get] Request ID from a previous list result'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'list': {
              let filtered = await networkLog.read();
              if (params.urlFilter) filtered = filtered.filter(r => r.url.includes(params.urlFilter!));
              if (params.method) filtered = filtered.filter(r => r.method.toUpperCase() === params.method!.toUpperCase());
              if (params.type) filtered = filtered.filter(r => r.type === params.type);
              if (params.statusCode) filtered = filtered.filter(r => r.statusCode === params.statusCode);
              const maxResults = params.limit || 50;
              const results = filtered.slice(-maxResults).reverse();
              return {
                total: filtered.length,
                returned: results.length,
                requests: results.map(r => ({
                  id: r.id, url: r.url, method: r.method, type: r.type,
                  statusCode: r.statusCode, timestamp: r.timestamp, fromCache: r.fromCache, error: r.error,
                })),
              };
            }
            case 'get': {
              const requests = await networkLog.read();
              const request = requests.find(r => r.id === params.requestId);
              if (!request) return { error: `Request not found: ${params.requestId}` };
              return request;
            }
            case 'clear': {
              const count = await networkLog.clear();
              return { success: true, clearedCount: count };
            }
          }
        },
      }),

      network_rules: tool({
        description:
          'Manage declarative network rules. Actions: ' +
          'block (block requests matching a URL pattern), ' +
          'unblock (remove a block rule by ID), ' +
          'redirect (redirect from one URL pattern to another), ' +
          'modify_headers (add/set/remove request or response headers), ' +
          'list (list all active rules), clear (remove all rules).',
        inputSchema: z.object({
          action: z.enum(['block', 'unblock', 'redirect', 'modify_headers', 'list', 'clear']).describe('The action to perform'),
          urlPattern: z.string().optional().describe('[block, modify_headers] URL pattern (supports * wildcards)'),
          resourceTypes: z.array(z.enum([
            'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
            'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
          ])).optional().describe('[block] Resource types to block (blocks all if omitted)'),
          ruleId: z.number().optional().describe('[unblock] Rule ID to remove'),
          fromPattern: z.string().optional().describe('[redirect] Source URL pattern (supports * wildcards)'),
          toUrl: z.string().optional().describe('[redirect] Destination URL'),
          requestHeaders: z.array(z.object({
            operation: z.enum(['append', 'set', 'remove']).describe('Header operation'),
            header: z.string().describe('Header name'),
            value: z.string().optional().describe('Header value (required for append/set)'),
          })).optional().describe('[modify_headers] Request header modifications'),
          responseHeaders: z.array(z.object({
            operation: z.enum(['append', 'set', 'remove']).describe('Header operation'),
            header: z.string().describe('Header name'),
            value: z.string().optional().describe('Header value (required for append/set)'),
          })).optional().describe('[modify_headers] Response header modifications'),
        }),
        execute: async (params: any) => {
          switch (params.action) {
            case 'block': {
              const ruleId = this.getNextRuleId();
              const rule: chrome.declarativeNetRequest.Rule = {
                id: ruleId,
                priority: 1,
                action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
                condition: {
                  urlFilter: params.urlPattern,
                  ...(params.resourceTypes && { resourceTypes: params.resourceTypes as chrome.declarativeNetRequest.ResourceType[] }),
                },
              };
              await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
              return { success: true, ruleId, urlPattern: params.urlPattern, action: 'block' };
            }
            case 'unblock': {
              await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [params.ruleId] });
              return { success: true, removedRuleId: params.ruleId };
            }
            case 'redirect': {
              const ruleId = this.getNextRuleId();
              const rule: chrome.declarativeNetRequest.Rule = {
                id: ruleId,
                priority: 1,
                action: {
                  type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
                  redirect: { url: params.toUrl },
                },
                condition: { urlFilter: params.fromPattern },
              };
              await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
              return { success: true, ruleId, from: params.fromPattern, to: params.toUrl, action: 'redirect' };
            }
            case 'modify_headers': {
              const ruleId = this.getNextRuleId();
              const action: chrome.declarativeNetRequest.RuleAction = {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              };
              if (params.requestHeaders && params.requestHeaders.length > 0) {
                action.requestHeaders = params.requestHeaders.map((h: any) => ({
                  operation: h.operation as chrome.declarativeNetRequest.HeaderOperation,
                  header: h.header,
                  ...(h.value && { value: h.value }),
                }));
              }
              if (params.responseHeaders && params.responseHeaders.length > 0) {
                action.responseHeaders = params.responseHeaders.map((h: any) => ({
                  operation: h.operation as chrome.declarativeNetRequest.HeaderOperation,
                  header: h.header,
                  ...(h.value && { value: h.value }),
                }));
              }
              const rule: chrome.declarativeNetRequest.Rule = {
                id: ruleId,
                priority: 1,
                action,
                condition: { urlFilter: params.urlPattern },
              };
              await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
              return { success: true, ruleId, urlPattern: params.urlPattern, requestHeaders: params.requestHeaders, responseHeaders: params.responseHeaders };
            }
            case 'list': {
              const rules = await chrome.declarativeNetRequest.getDynamicRules();
              return {
                count: rules.length,
                rules: rules.map(r => ({
                  id: r.id, priority: r.priority, action: r.action, condition: r.condition,
                })),
              };
            }
            case 'clear': {
              const rules = await chrome.declarativeNetRequest.getDynamicRules();
              const ruleIds = rules.map(r => r.id);
              if (ruleIds.length > 0) {
                await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
              }
              return { success: true, removedCount: ruleIds.length };
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

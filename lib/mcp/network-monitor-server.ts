import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool } from './types';
import { networkLog } from './session-store';

/**
 * Network Monitor MCP Server
 * Provides tools for monitoring and controlling network activity:
 * - List/filter network requests (via webRequest API)
 * - Block/redirect URLs (via declarativeNetRequest)
 * - Modify request/response headers
 * - Manage network rules
 *
 * Request capture itself lives in `collectors.ts` and only runs in the
 * background service worker; this server just reads the shared session log, so
 * the tools return the same data no matter which context executes them.
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
    // Capture is owned by the background collectors and intentionally keeps
    // running: disabling this server only withdraws its tools.
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
      { name: 'network_list_requests', description: 'List captured network requests with optional filtering', inputSchema: { type: 'object', properties: { urlFilter: { type: 'string' }, method: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' }, statusCode: { type: 'number' } } } },
      { name: 'network_get_request', description: 'Get detailed info for a specific network request by ID', inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] } },
      { name: 'network_clear_requests', description: 'Clear all captured network requests', inputSchema: { type: 'object', properties: {} } },
      { name: 'network_block_url', description: 'Block requests matching a URL pattern', inputSchema: { type: 'object', properties: { urlPattern: { type: 'string' }, resourceTypes: { type: 'array', items: { type: 'string' } } }, required: ['urlPattern'] } },
      { name: 'network_unblock_url', description: 'Remove a URL block rule', inputSchema: { type: 'object', properties: { ruleId: { type: 'number' } }, required: ['ruleId'] } },
      { name: 'network_redirect_url', description: 'Redirect requests from one URL pattern to another', inputSchema: { type: 'object', properties: { fromPattern: { type: 'string' }, toUrl: { type: 'string' } }, required: ['fromPattern', 'toUrl'] } },
      { name: 'network_modify_headers', description: 'Add, set, or remove request/response headers', inputSchema: { type: 'object', properties: { urlPattern: { type: 'string' }, requestHeaders: { type: 'array' }, responseHeaders: { type: 'array' } }, required: ['urlPattern'] } },
      { name: 'network_list_rules', description: 'List all active declarative net request rules', inputSchema: { type: 'object', properties: {} } },
      { name: 'network_clear_rules', description: 'Remove all dynamic network rules', inputSchema: { type: 'object', properties: {} } },
    ];
  }

  private getNextRuleId(): number {
    return Date.now() % 1000000;
  }

  getAITools(): Record<string, AnyTool> {
    return {
      network_list_requests: tool({
        description: 'List captured network requests. Can filter by URL pattern, HTTP method, resource type, or status code. Returns most recent requests first.',
        inputSchema: z.object({
          urlFilter: z.string().optional().describe('Filter by URL substring'),
          method: z.string().optional().describe('Filter by HTTP method (GET, POST, etc.)'),
          type: z.string().optional().describe('Filter by resource type (main_frame, script, stylesheet, image, xmlhttprequest, etc.)'),
          statusCode: z.number().optional().describe('Filter by HTTP status code'),
          limit: z.number().optional().describe('Maximum number of results (default 50)'),
        }),
        execute: async ({ urlFilter, method, type, statusCode, limit }) => {
          let filtered = await networkLog.read();
          if (urlFilter) filtered = filtered.filter(r => r.url.includes(urlFilter));
          if (method) filtered = filtered.filter(r => r.method.toUpperCase() === method.toUpperCase());
          if (type) filtered = filtered.filter(r => r.type === type);
          if (statusCode) filtered = filtered.filter(r => r.statusCode === statusCode);
          const maxResults = limit || 50;
          const results = filtered.slice(-maxResults).reverse();
          return {
            total: filtered.length,
            returned: results.length,
            requests: results.map(r => ({
              id: r.id,
              url: r.url,
              method: r.method,
              type: r.type,
              statusCode: r.statusCode,
              timestamp: r.timestamp,
              fromCache: r.fromCache,
              error: r.error,
            })),
          };
        },
      }),

      network_get_request: tool({
        description: 'Get detailed information for a specific captured network request by its ID.',
        inputSchema: z.object({
          requestId: z.string().describe('Request ID from network_list_requests'),
        }),
        execute: async ({ requestId }) => {
          const requests = await networkLog.read();
          const request = requests.find(r => r.id === requestId);
          if (!request) return { error: `Request not found: ${requestId}` };
          return request;
        },
      }),

      network_clear_requests: tool({
        description: 'Clear all captured network requests from the buffer.',
        inputSchema: z.object({}),
        execute: async () => {
          const count = await networkLog.clear();
          return { success: true, clearedCount: count };
        },
      }),

      network_block_url: tool({
        description: 'Block network requests matching a URL pattern using declarativeNetRequest. The pattern supports wildcards (*).',
        inputSchema: z.object({
          urlPattern: z.string().describe('URL pattern to block (supports * wildcards, e.g., "*://ads.example.com/*")'),
          resourceTypes: z.array(z.enum([
            'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
            'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
          ])).optional().describe('Resource types to block (optional, blocks all if not specified)'),
        }),
        execute: async ({ urlPattern, resourceTypes }) => {
          const ruleId = this.getNextRuleId();
          const rule: chrome.declarativeNetRequest.Rule = {
            id: ruleId,
            priority: 1,
            action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
            condition: {
              urlFilter: urlPattern,
              ...(resourceTypes && { resourceTypes: resourceTypes as chrome.declarativeNetRequest.ResourceType[] }),
            },
          };
          await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [rule],
          });
          return { success: true, ruleId, urlPattern, action: 'block' };
        },
      }),

      network_unblock_url: tool({
        description: 'Remove a URL blocking rule by its rule ID.',
        inputSchema: z.object({
          ruleId: z.number().describe('Rule ID returned from network_block_url'),
        }),
        execute: async ({ ruleId }) => {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId],
          });
          return { success: true, removedRuleId: ruleId };
        },
      }),

      network_redirect_url: tool({
        description: 'Redirect network requests from one URL pattern to another URL.',
        inputSchema: z.object({
          fromPattern: z.string().describe('Source URL pattern (supports * wildcards)'),
          toUrl: z.string().describe('Destination URL to redirect to'),
        }),
        execute: async ({ fromPattern, toUrl }) => {
          const ruleId = this.getNextRuleId();
          const rule: chrome.declarativeNetRequest.Rule = {
            id: ruleId,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
              redirect: { url: toUrl },
            },
            condition: {
              urlFilter: fromPattern,
            },
          };
          await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [rule],
          });
          return { success: true, ruleId, from: fromPattern, to: toUrl, action: 'redirect' };
        },
      }),

      network_modify_headers: tool({
        description: 'Add, set, or remove HTTP headers on requests or responses matching a URL pattern.',
        inputSchema: z.object({
          urlPattern: z.string().describe('URL pattern to match'),
          requestHeaders: z.array(z.object({
            operation: z.enum(['append', 'set', 'remove']).describe('Header operation'),
            header: z.string().describe('Header name'),
            value: z.string().optional().describe('Header value (required for append/set)'),
          })).optional().describe('Request header modifications'),
          responseHeaders: z.array(z.object({
            operation: z.enum(['append', 'set', 'remove']).describe('Header operation'),
            header: z.string().describe('Header name'),
            value: z.string().optional().describe('Header value (required for append/set)'),
          })).optional().describe('Response header modifications'),
        }),
        execute: async ({ urlPattern, requestHeaders, responseHeaders }) => {
          const ruleId = this.getNextRuleId();
          const action: chrome.declarativeNetRequest.RuleAction = {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          };
          if (requestHeaders && requestHeaders.length > 0) {
            action.requestHeaders = requestHeaders.map(h => ({
              operation: h.operation as chrome.declarativeNetRequest.HeaderOperation,
              header: h.header,
              ...(h.value && { value: h.value }),
            }));
          }
          if (responseHeaders && responseHeaders.length > 0) {
            action.responseHeaders = responseHeaders.map(h => ({
              operation: h.operation as chrome.declarativeNetRequest.HeaderOperation,
              header: h.header,
              ...(h.value && { value: h.value }),
            }));
          }
          const rule: chrome.declarativeNetRequest.Rule = {
            id: ruleId,
            priority: 1,
            action,
            condition: { urlFilter: urlPattern },
          };
          await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [rule],
          });
          return { success: true, ruleId, urlPattern, requestHeaders, responseHeaders };
        },
      }),

      network_list_rules: tool({
        description: 'List all currently active dynamic network rules (blocks, redirects, header modifications).',
        inputSchema: z.object({}),
        execute: async () => {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          return {
            count: rules.length,
            rules: rules.map(r => ({
              id: r.id,
              priority: r.priority,
              action: r.action,
              condition: r.condition,
            })),
          };
        },
      }),

      network_clear_rules: tool({
        description: 'Remove all dynamic network rules (blocks, redirects, header modifications).',
        inputSchema: z.object({}),
        execute: async () => {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          const ruleIds = rules.map(r => r.id);
          if (ruleIds.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              removeRuleIds: ruleIds,
            });
          }
          return { success: true, removedCount: ruleIds.length };
        },
      }),
    };
  }
}

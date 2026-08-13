import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool } from './types';
import { attachedTabs } from './session-store';
import { applyOutputLimit, DEFAULT_MAX_CHARS } from '@/lib/page/output-limit';
import type {
  PageActAction,
  PageRequest,
  PageResponse,
} from '@/lib/page/messages';

/** Where WXT emits the resident page content script inside the bundle. */
const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';

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
 * Wrap user code so CDP's `Runtime.evaluate` accepts the same input as the
 * `chrome.scripting` path.
 *
 * The two paths disagreed on what `code` means. `chrome.scripting` compiles it
 * as an `AsyncFunction` body, so a top-level `return` and top-level `await` are
 * both legal — which is what `page_evaluate`'s description promises. CDP
 * evaluates a *script*, where a top-level `return` is a hard
 * `SyntaxError: Illegal return statement`. Any code written against the
 * documented contract therefore failed the moment CSP forced the fallback.
 *
 * An async IIFE restores function-body semantics. `awaitPromise: true` on the
 * CDP side then unwraps the returned promise, so `await` keeps working too.
 *
 * Expression handling mirrors the scripting path's precedence: an expression
 * yields its value without an explicit `return` (`1 + 1`, `document.title`,
 * `({a: 1})`), so it is wrapped as `return (expr)`. Detection has to happen
 * here rather than by trial-and-error compilation, because a failed
 * `Runtime.evaluate` costs a round trip and would surface the wrong error.
 */
export function wrapCodeForCdp(code: string): string {
  const body = looksLikeExpression(code) ? `return (${code.replace(/;\s*$/, '')}\n);` : code;
  return `(async () => {\n${body}\n})()`;
}

/**
 * Decide whether `code` should be treated as a single expression.
 */
function looksLikeExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  const top = topLevelOnly(stripStringsAndComments(trimmed));
  if (/(^|[^\w$.])return([^\w$]|$)/.test(top)) return false;
  if (/(^|[^\w$.])(var|let|const|if|for|while|do|switch|throw|try|class|debugger)([^\w$]|$)/.test(top)) {
    return false;
  }
  if (/;/.test(top.replace(/;\s*$/, ''))) return false;
  return true;
}

/**
 * Blank the contents of every bracketed group, keeping only depth-0 source.
 */
function topLevelOnly(code: string): string {
  let depth = 0;
  let out = '';
  for (const char of code) {
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      out += char;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      out += char;
      continue;
    }
    out += depth === 0 ? char : ' ';
  }
  return out;
}

/**
 * Blank out string/template/regex literals and comments.
 */
function stripStringsAndComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Page Interaction MCP Server
 * Provides 9 unified tools for interacting with web page content:
 * - page_read: Content reading (Readability → Markdown)
 * - page_snapshot: Accessibility snapshot with stable refs + search/find
 * - page_evaluate: Universal JavaScript execution (replaces all DOM queries, scroll, focus, hover, etc.)
 * - page_click: Click elements by ref or selector
 * - page_fill: Unified form operations (input, textarea, select, checkbox, radio, batch fill)
 * - page_keyboard: Type text or press keys
 * - page_wait: Wait for arbitrary JS conditions
 * - page_screenshot: Capture viewport, full page, or element screenshots
 * - page_list_frames: Discover iframes
 */
export class PageInteractMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'page-interact',
      name: 'Page Interaction',
      description: 'Markdown page reading, accessibility snapshots with stable refs, JS evaluation, form filling, clicking, and screenshots',
      transport: 'builtin',
      builtin: true,
      enabled: true,
      icon: 'mouse-pointer-click',
    };
  }

  async connect(): Promise<void> {
    try {
      this.status = 'connecting';
      if (typeof chrome === 'undefined' || !chrome.scripting) {
        throw new Error('Chrome scripting API not available');
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

  private async getTargetTabId(tabId?: number): Promise<number> {
    if (tabId) return tabId;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error('No active tab found');
    return activeTab.id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeOnTab<T>(tabId: number, func: (...args: any[]) => T, args?: unknown[], frameId?: number): Promise<T> {
    const results = await chrome.scripting.executeScript({
      target: frameId !== undefined
        ? { tabId, frameIds: [frameId] }
        : { tabId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      func: func as (...args: any[]) => T,
      args: args || [],
    });
    if (!results || results.length === 0) {
      throw new Error('Script execution returned no results');
    }
    const firstResult = results[0]!;
    if (firstResult.result === undefined && (firstResult as { error?: unknown }).error) {
      throw new Error(`Script execution error: ${JSON.stringify((firstResult as { error?: unknown }).error)}`);
    }
    return firstResult.result as T;
  }

  /**
   * Run a CDP operation under a one-shot debugger attachment.
   */
  private async runWithDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    let attachedHere = false;
    if (!(await attachedTabs.has(tabId))) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        attachedHere = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Another debugger') && !message.includes('already attached')) {
          throw error;
        }
      }
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    }
    try {
      return await fn();
    } finally {
      if (attachedHere) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          // The tab may have closed mid-flight.
        }
        await attachedTabs.remove(tabId);
      }
    }
  }

  /**
   * Execute JavaScript via CDP Runtime.evaluate.
   */
  private async evaluateViaCDP(tabId: number, expression: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    try {
      const result = await this.runWithDebugger(tabId, () =>
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: wrapCodeForCdp(expression),
          returnByValue: true,
          awaitPromise: true,
          generatePreview: true,
        }),
      ) as { result: { type: string; value?: unknown; description?: string; subtype?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };

      if (result.exceptionDetails) {
        return { success: false, error: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
      }
      return { success: true, result: result.result.value ?? result.result.description ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `CDP evaluation failed: ${message}` };
    }
  }

  /**
   * Send a request to the page content script, injecting it on demand.
   */
  private async sendToContent(tabId: number, request: PageRequest): Promise<PageResponse> {
    const send = async (): Promise<PageResponse | undefined> => {
      try {
        return (await chrome.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
      } catch {
        return undefined;
      }
    };

    const first = await send();
    if (first) return first;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      });
    } catch (error) {
      throw new Error(
        `Page script unavailable on this page (${error instanceof Error ? error.message : String(error)}). ` +
          'Restricted pages such as chrome://, the Web Store and other extensions cannot be scripted; ' +
          'use page_evaluate with useCDP=true there instead.',
      );
    }

    const second = await send();
    if (second) return second;
    throw new Error(
      'Page script did not respond after injection. The page may have navigated ' +
        'mid-request; retry, or use page_evaluate with useCDP=true if the page cannot be scripted.',
    );
  }

  /**
   * Run a request through the content script and flatten the result.
   */
  private async requestPage(
    tabId: number | undefined,
    build: () => PageRequest,
  ): Promise<Record<string, unknown>> {
    let targetTabId: number;
    try {
      targetTabId = await this.getTargetTabId(tabId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const response = await this.sendToContent(targetTabId, build());
      if (!response.ok) return { error: response.error };
      const { ok: _ok, ...payload } = response;
      return payload as Record<string, unknown>;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Act on a `ref` from `page_snapshot`.
   */
  private async actOnRef(
    tabId: number | undefined,
    action: PageActAction,
    ref: string,
    extra: { value?: string; checked?: boolean | null } = {},
  ): Promise<Record<string, unknown>> {
    return this.requestPage(tabId, () => ({
      type: 'lumo:page:act',
      action,
      ref,
      ...extra,
    }));
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
      page_read: tool({
        description:
          'Read the page as clean Markdown, preserving heading levels, lists, tables, ' +
          'image alt text and link URLs while stripping navigation, ads and cookie ' +
          'banners. Mode "auto" (default) detects article-like pages and falls ' +
          'back to whole-page cleanup for app UIs. ' +
          'If the result reports truncated: true, call again with offset to continue.',
        inputSchema: z.object({
          mode: z.enum(['auto', 'article', 'full']).optional()
            .describe('auto (default): detect; article: force main-article extraction; full: whole page, chrome stripped'),
          selector: z.string().optional().describe('Limit extraction to a subtree (implies full mode)'),
          includeImages: z.boolean().optional().describe('Keep image markdown (default true)'),
          includeLinks: z.boolean().optional().describe('Keep link URLs (default true)'),
          maxChars: z.number().optional().describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z.number().optional().describe('Character offset, for paging through long pages'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ mode, selector, includeImages, includeLinks, maxChars, offset, tabId }) =>
          this.requestPage(tabId, () => ({
            type: 'lumo:page:read',
            mode: mode ?? 'auto',
            selector,
            includeImages: includeImages ?? true,
            includeLinks: includeLinks ?? true,
            maxChars,
            offset,
          })),
      }),

      page_snapshot: tool({
        description:
          'Capture a structured accessibility snapshot of the page: every element with ' +
          'its role, accessible name, state and a stable [ref=eN] handle. Pass a ref to ' +
          'page_click/page_fill instead of a CSS selector — refs survive DOM changes. ' +
          'Use the filter parameter (text or regex) to search within the snapshot and ' +
          'return only matching nodes with surrounding context, avoiding full-tree capture on large pages.',
        inputSchema: z.object({
          selector: z.string().optional().describe('Snapshot only this subtree'),
          interactiveOnly: z.boolean().optional().describe('Only elements that can be acted on (default false)'),
          depth: z.number().optional().describe('Truncate output below this tree depth'),
          filter: z.string().optional().describe('Search text (case-insensitive substring) or regex (wrap in slashes, e.g. "/error/i") to find specific elements'),
          filterContext: z.number().optional().describe('Levels of surrounding context for filter matches (default 2)'),
          maxChars: z.number().optional().describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z.number().optional().describe('Character offset, for paging'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, interactiveOnly, depth, filter, filterContext, maxChars, offset, tabId }) => {
          // If filter is provided, use the find pathway
          if (filter) {
            const isRegex = filter.startsWith('/');
            return this.requestPage(tabId, () => ({
              type: 'lumo:page:find',
              text: isRegex ? undefined : filter,
              regex: isRegex ? filter : undefined,
              context: filterContext ?? 2,
              maxChars,
              offset,
            }));
          }
          // Otherwise use the full snapshot pathway
          return this.requestPage(tabId, () => ({
            type: 'lumo:page:snapshot',
            selector,
            interactiveOnly: interactiveOnly ?? false,
            depth,
            maxChars,
            offset,
          }));
        },
      }),

      page_evaluate: tool({
        description:
          'Execute JavaScript code in the page context and return the result. ' +
          'The code may be a single expression (its value is returned automatically) or a statement block using an explicit `return`. ' +
          'Top-level `await` is supported. The result must be JSON-serializable. ' +
          'Use this for any DOM query, scroll, focus, hover, attribute reading, computed style, or other page inspection that doesn\'t need a dedicated tool. ' +
          'If blocked by CSP, automatically falls back to CDP Runtime.evaluate.',
        inputSchema: z.object({
          code: z.string().describe('JavaScript code to execute in the page'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          useCDP: z.boolean().optional().describe('Force using CDP Runtime.evaluate (bypasses CSP, auto-attaches debugger)'),
        }),
        execute: async ({ code, tabId, useCDP }) => {
          const targetTabId = await this.getTargetTabId(tabId);

          if (useCDP) {
            return this.evaluateViaCDP(targetTabId, code);
          }

          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              func: async (codeStr: string) => {
                const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
                  ...args: string[]
                ) => (...callArgs: unknown[]) => Promise<unknown>;

                let run: (...callArgs: unknown[]) => Promise<unknown>;
                const compile = (): string | undefined => {
                  try {
                    run = new AsyncFunction(`return (${codeStr}\n);`);
                    return;
                  } catch { /* not an expression */ }

                  const stripped = codeStr.replace(/;\s*$/, '');
                  if (stripped !== codeStr) {
                    try {
                      run = new AsyncFunction(`return (${stripped}\n);`);
                      return;
                    } catch { /* still not an expression */ }
                  }

                  try {
                    run = new AsyncFunction(codeStr);
                    return;
                  } catch (err) {
                    return err instanceof Error ? err.message : String(err);
                  }
                };

                const syntaxError = compile();
                if (syntaxError !== undefined) {
                  return { success: false, error: `SyntaxError: ${syntaxError}` };
                }

                try {
                  const value = await run!();
                  try {
                    return { success: true, result: JSON.parse(JSON.stringify(value ?? null)) };
                  } catch {
                    return { success: true, result: String(value), note: 'Result was not JSON-serializable and has been stringified.' };
                  }
                } catch (err) {
                  return {
                    success: false,
                    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
                  };
                }
              },
              args: [code],
            });

            const scriptResult = results?.[0]?.result as { success: boolean; error?: string } | undefined;

            if (scriptResult && !scriptResult.success && scriptResult.error &&
                (scriptResult.error.includes('EvalError') ||
                 scriptResult.error.includes('unsafe-eval') ||
                 scriptResult.error.includes('Content Security Policy'))) {
              return this.evaluateViaCDP(targetTabId, code);
            }

            return scriptResult ?? { success: false, error: 'Script execution returned no result' };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes('Cannot access') || errorMsg.includes('Cannot script') ||
                errorMsg.includes('Extension manifest')) {
              return this.evaluateViaCDP(targetTabId, code);
            }
            return { success: false, error: errorMsg };
          }
        },
      }),

      page_click: tool({
        description:
          'Click an element. Prefer ref from page_snapshot: a ref keeps pointing at the same element after the DOM changes, ' +
          'while a positional CSS selector silently drifts to a neighbour. Dispatches mousedown, mouseup, and click events.',
        inputSchema: z.object({
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID (ignored when ref is used)'),
        }),
        execute: async ({ ref, selector, tabId, frameId }) => {
          if (ref) return this.actOnRef(tabId, 'click', ref);
          if (!selector) return { error: 'Provide either ref or selector' };
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return { error: `Element not found: ${sel}` };
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            el.click();
            return { success: true, tag: el.tagName.toLowerCase(), text: el.textContent?.trim().slice(0, 100) || '' };
          }, [selector], frameId);
        },
      }),

      page_fill: tool({
        description:
          'Fill form elements. Supports input/textarea (type: "text"), select dropdowns (type: "select"), ' +
          'checkboxes/radios (type: "check"), and batch operations (type: "batch"). ' +
          'Prefer ref from page_snapshot over CSS selectors. ' +
          'For text inputs: clears existing value, sets new value via native setter (React-compatible), triggers input/change events. ' +
          'For selects: matches by value or visible text. For checkboxes: toggles or sets explicitly.',
        inputSchema: z.object({
          type: z.enum(['text', 'select', 'check', 'batch']).describe('The fill type to perform'),
          value: z.string().optional().describe('[text, select] Value to fill or option to select'),
          ref: z.string().optional().describe('[text, select, check] Element ref from page_snapshot (preferred)'),
          selector: z.string().optional().describe('[text, select, check] CSS selector (fallback)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('[text] Frame ID (ignored when ref is used)'),
          checked: z.boolean().optional().describe('[check] Target state (omit to toggle)'),
          fields: z.array(z.object({
            selector: z.string().describe('CSS selector of the form field'),
            value: z.string().describe('Value to fill'),
          })).optional().describe('[batch] Array of fields to fill'),
        }),
        execute: async (params: any) => {
          switch (params.type) {
            case 'text': {
              if (params.ref) return this.actOnRef(params.tabId, 'fill', params.ref, { value: params.value });
              if (!params.selector) return { error: 'Provide either ref or selector' };
              const targetTabId = await this.getTargetTabId(params.tabId);
              return this.executeOnTab(targetTabId, (sel: string, val: string) => {
                const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
                if (!el) return { error: `Element not found: ${sel}` };
                el.focus();
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                )?.set || Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                )?.set;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(el, val);
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, selector: sel, filledValue: val };
              }, [params.selector, params.value], params.frameId);
            }
            case 'select': {
              if (params.ref) return this.actOnRef(params.tabId, 'select-option', params.ref, { value: params.value });
              if (!params.selector) return { error: 'Provide either ref or selector' };
              const targetTabId = await this.getTargetTabId(params.tabId);
              return this.executeOnTab(targetTabId, (sel: string, val: string) => {
                const el = document.querySelector(sel) as HTMLSelectElement;
                if (!el) return { error: `Element not found: ${sel}` };
                if (el.tagName.toLowerCase() !== 'select') return { error: `Element is not a select: ${el.tagName}` };
                // Try matching by value first, then by visible text
                let matched = false;
                for (const opt of el.options) {
                  if (opt.value === val || opt.text === val) {
                    el.value = opt.value;
                    matched = true;
                    break;
                  }
                }
                if (!matched) el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, selectedValue: el.value, selectedText: el.options[el.selectedIndex]?.text };
              }, [params.selector, params.value]);
            }
            case 'check': {
              if (params.ref) {
                return this.actOnRef(params.tabId, 'check-checkbox', params.ref, {
                  checked: params.checked !== undefined ? params.checked : null,
                });
              }
              if (!params.selector) return { error: 'Provide either ref or selector' };
              const targetTabId = await this.getTargetTabId(params.tabId);
              return this.executeOnTab(targetTabId, (sel: string, shouldCheck: boolean | null) => {
                const el = document.querySelector(sel) as HTMLInputElement;
                if (!el) return { error: `Element not found: ${sel}` };
                if (el.type !== 'checkbox' && el.type !== 'radio') return { error: `Element is not a checkbox/radio: ${el.type}` };
                const newValue = shouldCheck !== null ? shouldCheck : !el.checked;
                el.checked = newValue;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return { success: true, checked: el.checked };
              }, [params.selector, params.checked !== undefined ? params.checked : null]);
            }
            case 'batch': {
              const targetTabId = await this.getTargetTabId(params.tabId);
              return this.executeOnTab(targetTabId, (fieldList: Array<{ selector: string; value: string }>) => {
                const results: Array<{ selector: string; success: boolean; error?: string }> = [];
                for (const field of fieldList) {
                  const el = document.querySelector(field.selector) as HTMLInputElement | HTMLTextAreaElement;
                  if (!el) {
                    results.push({ selector: field.selector, success: false, error: 'Element not found' });
                    continue;
                  }
                  el.focus();
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  )?.set || Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                  )?.set;
                  if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(el, field.value);
                  } else {
                    el.value = field.value;
                  }
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  results.push({ selector: field.selector, success: true });
                }
                return { results };
              }, [params.fields]);
            }
          }
        },
      }),

      page_keyboard: tool({
        description:
          'Keyboard input. Actions: type (type text character-by-character with keyboard events), ' +
          'press (press a single key like Enter, Escape, Tab, ArrowDown). ' +
          'Operates on the focused element, or specify a selector to focus first.',
        inputSchema: z.object({
          action: z.enum(['type', 'press']).describe('The action to perform'),
          text: z.string().optional().describe('[type] Text to type character by character'),
          key: z.string().optional().describe('[press] Key to press (e.g., "Enter", "Escape", "Tab", "Space", "ArrowDown")'),
          selector: z.string().optional().describe('CSS selector of element (uses focused element if omitted)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async (params: any) => {
          const targetTabId = await this.getTargetTabId(params.tabId);
          switch (params.action) {
            case 'type': {
              return this.executeOnTab(targetTabId, (txt: string, sel: string) => {
                const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLInputElement;
                if (!el) return { error: sel ? `Element not found: ${sel}` : 'No focused element' };
                if (sel) el.focus();
                for (const char of txt) {
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
                  const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  )?.set || Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                  )?.set;
                  const newValue = (el.value || '') + char;
                  if (nativeSetter) {
                    nativeSetter.call(el, newValue);
                  } else {
                    el.value = newValue;
                  }
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, typed: txt, length: txt.length };
              }, [params.text, params.selector || '']);
            }
            case 'press': {
              return this.executeOnTab(targetTabId, (k: string, sel: string) => {
                const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLElement;
                if (!el) return { error: sel ? `Element not found: ${sel}` : 'No focused element' };
                if (sel) el.focus();
                const opts = { key: k, code: k, bubbles: true, cancelable: true };
                el.dispatchEvent(new KeyboardEvent('keydown', opts));
                el.dispatchEvent(new KeyboardEvent('keypress', opts));
                el.dispatchEvent(new KeyboardEvent('keyup', opts));
                if (k === 'Enter' && el.closest('form')) {
                  const form = el.closest('form');
                  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
                return { success: true, key: k };
              }, [params.key, params.selector || '']);
            }
          }
        },
      }),

      page_wait: tool({
        description:
          'Wait for a condition to become true on the page. The condition is a JavaScript expression ' +
          'that will be evaluated repeatedly (every 100ms) until it returns a truthy value or times out. ' +
          'Examples: "document.querySelector(\'.loaded\')" (wait for element), ' +
          '"document.body.innerText.includes(\'Success\')" (wait for text), ' +
          '"document.readyState === \'complete\'" (wait for load).',
        inputSchema: z.object({
          condition: z.string().describe('JavaScript expression that returns truthy when the condition is met'),
          timeout: z.number().optional().describe('Timeout in milliseconds (default 5000)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ condition, timeout, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const maxTime = timeout || 5000;
          const startTime = Date.now();

          // Try scripting API with Function constructor (avoids eval CSP issues)
          // The injected function returns { ok: true, value: bool } on success
          // or { ok: false } when Function constructor is blocked by CSP
          const pollViaScripting = async (): Promise<{ ok: boolean; value: boolean }> => {
            return await this.executeOnTab(targetTabId, (code: string) => {
              try {
                const fn = new Function(`return (${code})`) as () => unknown;
                return { ok: true, value: !!fn() };
              } catch {
                return { ok: false, value: false };
              }
            }, [condition]) as { ok: boolean; value: boolean };
          };

          try {
            const probe = await pollViaScripting();
            if (probe.ok) {
              // Scripting works — use it for polling
              if (probe.value) return { success: true, condition, elapsed: Date.now() - startTime };

              while (Date.now() - startTime < maxTime) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const poll = await pollViaScripting();
                if (poll.value) return { success: true, condition, elapsed: Date.now() - startTime };
              }
              return { error: `Timeout waiting for condition: ${condition}`, timeout: maxTime };
            }
            // Function constructor blocked by CSP — fall through to CDP
          } catch {
            // executeScript itself failed (restricted page) — fall through to CDP
          }

          // CDP fallback: poll via Runtime.evaluate
          while (Date.now() - startTime < maxTime) {
            const cdpResult = await this.evaluateViaCDP(targetTabId, condition);
            if (cdpResult.success && cdpResult.result) {
              return { success: true, condition, elapsed: Date.now() - startTime };
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return { error: `Timeout waiting for condition: ${condition}`, timeout: maxTime };
        },
      }),

      page_screenshot: tool({
        description:
          'Take a screenshot. Scope: "viewport" (visible area, default), "fullpage" (entire page beyond viewport, uses CDP), ' +
          '"element" (specific element by CSS selector, uses CDP). Returns base64-encoded image.',
        inputSchema: z.object({
          scope: z.enum(['viewport', 'fullpage', 'element']).optional().default('viewport').describe('Screenshot scope'),
          format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Image format (default png)'),
          quality: z.number().optional().describe('Image quality 0-100 (for jpeg/webp)'),
          selector: z.string().optional().describe('[element] CSS selector of the element to screenshot'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async (params: any) => {
          const targetTabId = await this.getTargetTabId(params.tabId);

          switch (params.scope) {
            case 'viewport': {
              const tab = await chrome.tabs.get(targetTabId);
              if (!tab.active) {
                await chrome.tabs.update(targetTabId, { active: true });
                await new Promise((resolve) => setTimeout(resolve, 200));
              }
              const imageFormat = params.format || 'png';
              const options: { format?: string; quality?: number } = { format: imageFormat };
              if (params.format === 'jpeg' && params.quality !== undefined) {
                options.quality = params.quality;
              }
              const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options as chrome.extensionTypes.ImageDetails);
              const comma = dataUrl.indexOf(',');
              const mimeType = dataUrl.slice(5, comma).split(';')[0] || (imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png');
              return {
                content: [
                  { type: 'image', data: comma > 0 ? dataUrl.slice(comma + 1) : dataUrl, mimeType },
                  { type: 'text', text: `Screenshot captured (${imageFormat}, viewport)` },
                ],
                isError: false,
              };
            }
            case 'fullpage': {
              return this.runWithDebugger(targetTabId, async () => {
                const layoutMetrics = await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.getLayoutMetrics') as {
                  contentSize: { width: number; height: number };
                };
                const { width, height } = layoutMetrics.contentSize;
                const result = await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.captureScreenshot', {
                  format: params.format || 'png',
                  quality: params.quality || undefined,
                  clip: { x: 0, y: 0, width, height, scale: 1 },
                  captureBeyondViewport: true,
                }) as { data: string };
                return {
                  content: [
                    { type: 'image', data: result.data, mimeType: `image/${params.format || 'png'}` },
                    { type: 'text', text: `Full-page screenshot captured (${params.format || 'png'}, ${width}x${height})` },
                  ],
                  isError: false,
                };
              });
            }
            case 'element': {
              return this.runWithDebugger(targetTabId, async () => {
                const boundsResult = await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Runtime.evaluate', {
                  expression: `(() => { const el = document.querySelector('${params.selector.replace(/'/g, "\\'")}'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
                  returnByValue: true,
                }) as { result: { value: { x: number; y: number; width: number; height: number } | null } };
                const bounds = boundsResult.result?.value;
                if (!bounds) return { error: `Element not found: ${params.selector}` };
                const result = await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.captureScreenshot', {
                  format: params.format || 'png',
                  quality: params.quality || undefined,
                  clip: { ...bounds, scale: 1 },
                }) as { data: string };
                return {
                  content: [
                    { type: 'image', data: result.data, mimeType: `image/${params.format || 'png'}` },
                    { type: 'text', text: `Element screenshot captured (${params.selector}, ${Math.round(bounds.width)}x${Math.round(bounds.height)})` },
                  ],
                  isError: false,
                };
              });
            }
          }
        },
      }),

      page_list_frames: tool({
        description: 'List all frames (iframes) in a tab with their frame IDs, URLs, and type. Use the returned frameId with page_evaluate or page_click to operate on iframe content.',
        inputSchema: z.object({
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const frames = await chrome.webNavigation.getAllFrames({ tabId: targetTabId });
          if (!frames) return { error: 'Could not get frames for tab' };
          return {
            frames: frames.map((frame) => ({
              frameId: frame.frameId,
              parentFrameId: frame.parentFrameId,
              url: frame.url,
              frameType: frame.frameId === 0 ? 'main_frame' : 'sub_frame',
            })),
            total: frames.length,
          };
        },
      }),
    };
  }
}

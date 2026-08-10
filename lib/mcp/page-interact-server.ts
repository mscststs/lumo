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
 *
 * `z.toJSONSchema` throws on constructs it cannot represent; a tool list is a
 * display concern, so an unrepresentable schema degrades to a bare object rather
 * than breaking the page.
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
 *
 * Only the *top level* is inspected. Keywords and `;` nested inside brackets
 * belong to an inner function body and say nothing about the outer form — an
 * IIFE like `(() => { const a = 1; return a; })()` is a perfectly good
 * expression, and `({ const: 1 }).const` uses a keyword as a property name.
 *
 * Otherwise conservative: a top-level statement keyword, `return`, or a `;`
 * separating statements means statement form. A false negative merely requires
 * the caller's explicit `return` (already the documented fallback); a false
 * positive would turn working code into a syntax error.
 */
function looksLikeExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  const top = topLevelOnly(stripStringsAndComments(trimmed));
  // A top-level `return` is only valid in the statement form.
  if (/(^|[^\w$.])return([^\w$]|$)/.test(top)) return false;
  // Statement-only keywords cannot appear in an expression position.
  if (/(^|[^\w$.])(var|let|const|if|for|while|do|switch|throw|try|class|debugger)([^\w$]|$)/.test(top)) {
    return false;
  }
  // A `;` anywhere but the very end means multiple statements.
  if (/;/.test(top.replace(/;\s*$/, ''))) return false;
  return true;
}

/**
 * Blank the contents of every bracketed group, keeping only depth-0 source.
 * Lets keyword/`;` detection ignore nested function bodies and object literals.
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
 * Blank out string/template/regex literals and comments so keyword and `;`
 * detection cannot be fooled by their contents (e.g. `"return"`, `a/*;*\/b`).
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
 * Provides tools for interacting with web page content:
 * - Content reading (`page_read`: Readability → Markdown)
 * - Structure & interaction (`page_snapshot` / `page_find`: ARIA tree + stable refs)
 * - DOM reading (attributes, computed styles) and querying
 * - User interaction simulation (click, fill, type, hover, scroll) by ref or selector
 * - Form manipulation (fill form, select options)
 * - Wait operations (wait for selector, text)
 * - Screenshot capture
 *
 * `page_read` / `page_snapshot` / `page_find` and the `ref` branch of the action
 * tools run in the resident content script (`entrypoints/content.ts`), because
 * element identity has to outlive a single call. Everything else keeps using
 * `chrome.scripting.executeScript`, which still works on pages where a content
 * script cannot be injected.
 */
export class PageInteractMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'page-interact',
      name: 'Page Interaction',
      description: 'Markdown page reading, accessibility snapshots with stable refs, DOM manipulation, form filling, clicking, and screenshots',
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
   *
   * `page_evaluate` (and its CSP fallback) needs CDP's `Runtime.evaluate` for a
   * single execution, but `chrome.debugger.attach` is a persistent, per-extension
   * session that surfaces a "debugging" infobar on the tab. Leaving it behind
   * after a one-shot call is a user-visible state leak, so we attach only when
   * *we* are the first to attach and always release in `finally` — yet only the
   * attachment we made, never a session owned by another context (DevTools
   * Advanced, or an explicit `debug_attach`).
   */
  private async runWithDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    let attachedHere = false;
    if (!(await attachedTabs.has(tabId))) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        attachedHere = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Another context attached first; that session is not ours to release.
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
          // The tab may have closed mid-flight; nothing left to release.
        }
        await attachedTabs.remove(tabId);
      }
    }
  }

  /**
   * Execute JavaScript via CDP Runtime.evaluate. Used as fallback when
   * chrome.scripting is blocked by CSP, or when page_evaluate is called
   * with useCDP=true.
   */
  private async evaluateViaCDP(tabId: number, expression: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    try {
      const result = await this.runWithDebugger(tabId, () =>
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          // `Runtime.evaluate` runs a script, not a function body; see
          // `wrapCodeForCdp` for why the raw code cannot be passed through.
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
   * Send a request to the page content script, injecting it on demand when the
   * tab predates the extension (or was reloaded before the script registered).
   *
   * Injection cannot be driven by `sendMessage` rejecting. That only happens when
   * a tab has *no* listener at all, and every tab already has one: the WebMCP
   * bridge registers at `document_start` on `<all_urls>` and returns `false` for
   * messages outside its own namespace. A foreign listener declining a message
   * still makes `sendMessage` resolve — with `undefined`. So the signal that our
   * script is absent is an undefined *response*, not a thrown error.
   */
  private async sendToContent(tabId: number, request: PageRequest): Promise<PageResponse> {
    const send = async (): Promise<PageResponse | undefined> => {
      try {
        return (await chrome.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
      } catch {
        // No listener whatsoever, or the tab went away mid-flight.
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
          'use page_get_text or page_get_html there instead.',
      );
    }

    const second = await send();
    if (second) return second;
    throw new Error(
      'Page script did not respond after injection. The page may have navigated ' +
        'mid-request; retry, or use page_get_text if the page cannot be scripted.',
    );
  }

  /**
   * Run a request through the content script and flatten the result into the
   * tool convention: `{ error }` for failures (which `registry.ts` turns into
   * `isError: true`), the payload itself otherwise.
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
   *
   * A ref that no longer resolves returns an explicit error rather than falling
   * back to a selector: silently operating on a neighbouring element is the
   * data-corruption failure mode this whole path exists to remove.
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

  /**
   * UI-facing tool list, derived from the same zod schemas the model sees.
   *
   * This used to be a hand-written JSON Schema array kept in sync by hand, and
   * it had already drifted (`frameId` was missing from several entries). Deriving
   * it removes the class of bug rather than fixing one instance.
   */
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
          'banners. Prefer this over page_get_text or page_get_html for understanding ' +
          'page content. Mode "auto" (default) detects article-like pages and falls ' +
          'back to whole-page cleanup for app UIs such as dashboards or search results. ' +
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
          'its role, accessible name, state ([disabled]/[checked]/[level=N]) and a ' +
          'stable [ref=eN] handle. Pass a ref to page_click/page_fill instead of a CSS ' +
          'selector — refs keep pointing at the same element after the DOM changes, ' +
          'while positional selectors silently drift to a neighbour. Use page_find on ' +
          'large pages to avoid capturing the whole tree.',
        inputSchema: z.object({
          selector: z.string().optional().describe('Snapshot only this subtree'),
          interactiveOnly: z.boolean().optional().describe('Only elements that can be acted on (default false)'),
          depth: z.number().optional().describe('Truncate output below this tree depth. Does not affect which elements are discovered.'),
          maxChars: z.number().optional().describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z.number().optional().describe('Character offset, for paging through large snapshots'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, interactiveOnly, depth, maxChars, offset, tabId }) =>
          this.requestPage(tabId, () => ({
            type: 'lumo:page:snapshot',
            selector,
            interactiveOnly: interactiveOnly ?? false,
            depth,
            maxChars,
            offset,
          })),
      }),

      page_find: tool({
        description:
          'Search the page accessibility snapshot for text or a regex and return only ' +
          'the matching nodes with their path from the root and surrounding context. ' +
          'Much cheaper than page_snapshot when you only need to locate one element ' +
          'and its ref.',
        inputSchema: z.object({
          text: z.string().optional().describe('Case-insensitive substring. Provide text or regex, not both.'),
          regex: z.string().optional().describe('Regex; wrap in slashes for flags, e.g. "/error/i"'),
          context: z.number().optional().describe('Levels of surrounding context to render (default 2)'),
          maxChars: z.number().optional().describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z.number().optional().describe('Character offset, for paging through many matches'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ text, regex, context, maxChars, offset, tabId }) =>
          this.requestPage(tabId, () => ({
            type: 'lumo:page:find',
            text,
            regex,
            context: context ?? 2,
            maxChars,
            offset,
          })),
      }),

      page_evaluate: tool({
        description: 'Execute JavaScript code in the page context and return the result. The code may be a single expression (its value is returned automatically) or a statement block using an explicit `return`. Top-level `await` is supported. The result must be JSON-serializable. If blocked by CSP, automatically falls back to CDP Runtime.evaluate (requires debugger, will auto-attach).',
        inputSchema: z.object({
          code: z.string().describe('JavaScript code to execute in the page'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          useCDP: z.boolean().optional().describe('Force using CDP Runtime.evaluate instead of chrome.scripting (bypasses CSP, auto-attaches debugger)'),
        }),
        execute: async ({ code, tabId, useCDP }) => {
          const targetTabId = await this.getTargetTabId(tabId);

          // If useCDP is explicitly set, go directly to CDP
          if (useCDP) {
            return this.evaluateViaCDP(targetTabId, code);
          }

          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              func: async (codeStr: string) => {
                // Compile the code with the AsyncFunction constructor instead of
                // `eval`. Unlike a direct `eval` call this does not capture the
                // surrounding scope (so the injected wrapper's own variables stay
                // invisible to user code), it runs in global scope like a real
                // page script, it allows top-level `await`, and it does not force
                // the bundler to deoptimize/skip minification of this module.
                const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
                  ...args: string[]
                ) => (...callArgs: unknown[]) => Promise<unknown>;

                let run: (...callArgs: unknown[]) => Promise<unknown>;
                const compile = (): string | undefined => {
                  // 1. Prefer expression semantics so `1 + 1`, `document.title`
                  //    or `({a: 1})` return their value without an explicit return.
                  try {
                    run = new AsyncFunction(`return (${codeStr}\n);`);
                    return;
                  } catch { /* not an expression, keep trying */ }

                  // 2. Retry as an expression with trailing semicolons removed,
                  //    so `document.title;` still returns a value instead of
                  //    silently falling through to statement mode (which yields
                  //    undefined).
                  const stripped = codeStr.replace(/;\s*$/, '');
                  if (stripped !== codeStr) {
                    try {
                      run = new AsyncFunction(`return (${stripped}\n);`);
                      return;
                    } catch { /* still not an expression */ }
                  }

                  // 3. Fall back to a statement body needing an explicit `return`.
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
                  // Surface non-serializable results explicitly instead of
                  // letting them silently turn into undefined/null.
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

            // Check if CSP blocked the execution
            if (scriptResult && !scriptResult.success && scriptResult.error &&
                (scriptResult.error.includes('EvalError') || 
                 scriptResult.error.includes('unsafe-eval') ||
                 scriptResult.error.includes('Content Security Policy'))) {
              // Fallback to CDP. The transport used is an implementation
              // detail; annotating the result only pollutes the payload the
              // caller has to parse.
              return this.evaluateViaCDP(targetTabId, code);
            }

            return scriptResult ?? { success: false, error: 'Script execution returned no result' };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // If the scripting API itself failed (e.g., cannot inject into chrome:// pages),
            // try CDP as fallback
            if (errorMsg.includes('Cannot access') || errorMsg.includes('Cannot script') ||
                errorMsg.includes('Extension manifest')) {
              return this.evaluateViaCDP(targetTabId, code);
            }
            return { success: false, error: errorMsg };
          }
        },
      }),

      page_get_text: tool({
        description:
          '[Deprecated — prefer page_read] Get raw visible text via innerText. ' +
          'Returns no heading levels, link URLs, image alt text or table structure. ' +
          'Kept as an escape hatch for pages where the content script cannot run ' +
          '(chrome://, the Web Store, other extension pages).',
        inputSchema: z.object({
          selector: z.string().optional().describe('CSS selector to get text from (optional, defaults to body)'),
          maxChars: z.number().optional().describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z.number().optional().describe('Character offset, for paging through long pages'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame.'),
        }),
        execute: async ({ selector, maxChars, offset, tabId, frameId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const result = await this.executeOnTab(targetTabId, (sel: string) => {
            const el = sel ? document.querySelector(sel) : document.body;
            if (!el) return { error: `Element not found: ${sel}` };
            // Use innerText instead of textContent to preserve line breaks between
            // block elements and respect CSS visibility (hidden elements excluded).
            const text = (el as HTMLElement).innerText?.trim() || '';
            return { text };
          }, [selector || ''], frameId);
          if ('error' in result) return result;
          // The whole page used to be returned regardless of size; a single call
          // could exhaust the context window.
          const limited = applyOutputLimit(result.text, { maxChars, offset });
          return { text: limited.text, length: limited.text.length, limit: limited.limit };
        },
      }),

      page_get_html: tool({
        description:
          '[Deprecated — prefer page_read] Get raw HTML of the page or an element. ' +
          'Verbose and full of markup noise; use page_read for content or ' +
          'page_snapshot for structure. Kept as an escape hatch for pages where the ' +
          'content script cannot run.',
        inputSchema: z.object({
          selector: z.string().optional().describe('CSS selector (optional, defaults to document root)'),
          outer: z.boolean().optional().describe('If true, return outerHTML; if false, return innerHTML (default false)'),
          maxChars: z.number().optional().describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z.number().optional().describe('Character offset, for paging through long documents'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, outer, maxChars, offset, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const result = await this.executeOnTab(targetTabId, (sel: string, getOuter: boolean) => {
            const el = sel ? document.querySelector(sel) : document.documentElement;
            if (!el) return { error: `Element not found: ${sel}` };
            return { html: getOuter ? el.outerHTML : el.innerHTML };
          }, [selector || '', outer || false]);
          if ('error' in result) return result;
          const limited = applyOutputLimit(result.html, { maxChars, offset });
          return { html: limited.text, limit: limited.limit };
        },
      }),

      page_query_selector: tool({
        description: 'Query a single element and return its tag, text content, attributes, bounding rect, and visibility.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector to query'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame.'),
        }),
        execute: async ({ selector, tabId, frameId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            const rect = el.getBoundingClientRect();
            const attrs: Record<string, string> = {};
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value;
            }
            return {
              tag: el.tagName.toLowerCase(),
              text: el.textContent?.trim().slice(0, 500) || '',
              attributes: attrs,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              visible: rect.width > 0 && rect.height > 0,
              value: (el as HTMLInputElement).value || undefined,
            };
          }, [selector], frameId);
        },
      }),

      page_query_selector_all: tool({
        description: 'Query all matching elements and return their properties. Returns tag, text, id, class, attributes, and optionally bounding rect.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector to query'),
          limit: z.number().optional().describe('Maximum number of elements to return (default 50)'),
          detailed: z.boolean().optional().describe('If true, include bounding rect and all attributes for each element (default false)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, limit, detailed, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, maxCount: number, isDetailed: boolean) => {
            const elements = document.querySelectorAll(sel);
            const results: Array<{
              index: number; tag: string; text: string;
              id?: string; className?: string; href?: string; value?: string;
              name?: string; type?: string; selector?: string;
              rect?: { x: number; y: number; width: number; height: number };
              attributes?: Record<string, string>;
              visible?: boolean;
            }> = [];
            const count = Math.min(elements.length, maxCount);
            for (let i = 0; i < count; i++) {
              const el = elements[i]!;
              // Generate a usable selector for the element
              let elSelector: string | undefined;
              if (el.id) {
                elSelector = `#${el.id}`;
              } else if (el.getAttribute('name')) {
                elSelector = `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
              } else {
                // Use nth-of-type from the base selector
                elSelector = `${sel}:nth-of-type(${i + 1})`;
              }

              const entry: typeof results[number] = {
                index: i,
                tag: el.tagName.toLowerCase(),
                text: (el as HTMLElement).innerText?.trim().slice(0, 200) || el.textContent?.trim().slice(0, 200) || '',
                id: el.id || undefined,
                className: el.className || undefined,
                href: (el as HTMLAnchorElement).href || undefined,
                value: (el as HTMLInputElement).value || undefined,
                name: el.getAttribute('name') || undefined,
                type: (el as HTMLInputElement).type || undefined,
                selector: elSelector,
              };

              if (isDetailed) {
                const rect = el.getBoundingClientRect();
                entry.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                entry.visible = rect.width > 0 && rect.height > 0;
                const attrs: Record<string, string> = {};
                for (const attr of el.attributes) {
                  attrs[attr.name] = attr.value;
                }
                entry.attributes = attrs;
              }

              results.push(entry);
            }
            return { total: elements.length, returned: count, elements: results };
          }, [selector, limit || 50, detailed || false]);
        },
      }),

      page_get_attribute: tool({
        description: 'Get a specific attribute value of an element.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector'),
          attribute: z.string().describe('Attribute name to get'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, attribute, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, attr: string) => {
            const el = document.querySelector(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            return { selector: sel, attribute: attr, value: el.getAttribute(attr) };
          }, [selector, attribute]);
        },
      }),

      page_get_computed_style: tool({
        description: 'Get computed CSS style properties of an element.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector'),
          properties: z.array(z.string()).optional().describe('Specific CSS properties to get (optional, returns common ones by default)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, properties, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, props: string[]) => {
            const el = document.querySelector(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            const computed = getComputedStyle(el);
            const defaultProps = ['display', 'visibility', 'opacity', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'width', 'height', 'position', 'overflow'];
            const targetProps = props.length > 0 ? props : defaultProps;
            const styles: Record<string, string> = {};
            for (const prop of targetProps) {
              styles[prop] = computed.getPropertyValue(prop) || (computed as unknown as Record<string, string>)[prop] || '';
            }
            return { selector: sel, styles };
          }, [selector, properties || []]);
        },
      }),

      page_click: tool({
        description: 'Click an element. Prefer ref from page_snapshot: a ref keeps pointing at the same element after the DOM changes, while a positional CSS selector silently drifts to a neighbour. Dispatches mousedown, mouseup, and click events.',
        inputSchema: z.object({
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed since you looked)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame. Ignored when ref is used.'),
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
        description: 'Fill an input or textarea with text. Prefer ref from page_snapshot over a CSS selector. Clears the existing value, then sets the new value via the native setter (so React controlled components update) and triggers input/change events.',
        inputSchema: z.object({
          value: z.string().describe('Value to fill in'),
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed since you looked)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame. Ignored when ref is used.'),
        }),
        execute: async ({ ref, selector, value, tabId, frameId }) => {
          if (ref) return this.actOnRef(tabId, 'fill', ref, { value });
          if (!selector) return { error: 'Provide either ref or selector' };
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, val: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
            if (!el) return { error: `Element not found: ${sel}` };
            el.focus();
            // Use native setter to bypass React controlled components
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
          }, [selector, value], frameId);
        },
      }),

      page_fill_form: tool({
        description: 'Fill multiple form fields at once. Each field is specified by selector and value.',
        inputSchema: z.object({
          fields: z.array(z.object({
            selector: z.string().describe('CSS selector of the form field'),
            value: z.string().describe('Value to fill'),
          })).describe('Array of fields to fill'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ fields, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
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
          }, [fields]);
        },
      }),

      page_select_option: tool({
        description: 'Select an option in a <select> element by value or visible text. Prefer ref from page_snapshot over a CSS selector.',
        inputSchema: z.object({
          value: z.string().describe('Value (or visible text) of the option to select'),
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed since you looked)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ ref, selector, value, tabId }) => {
          if (ref) return this.actOnRef(tabId, 'select-option', ref, { value });
          if (!selector) return { error: 'Provide either ref or selector' };
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, val: string) => {
            const el = document.querySelector(sel) as HTMLSelectElement;
            if (!el) return { error: `Element not found: ${sel}` };
            if (el.tagName.toLowerCase() !== 'select') return { error: `Element is not a select: ${el.tagName}` };
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, selectedValue: el.value, selectedText: el.options[el.selectedIndex]?.text };
          }, [selector, value]);
        },
      }),

      page_type_text: tool({
        description: 'Type text character by character into an element, simulating keyboard events for each character.',
        inputSchema: z.object({
          text: z.string().describe('Text to type'),
          selector: z.string().optional().describe('CSS selector of element to type into (optional, types into focused element)'),
          delay: z.number().optional().describe('Delay between keystrokes in ms (default 0, executed synchronously)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ text, selector, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (txt: string, sel: string) => {
            const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLInputElement;
            if (!el) return { error: sel ? `Element not found: ${sel}` : 'No focused element' };
            if (sel) el.focus();
            for (const char of txt) {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
              // Append character
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
          }, [text, selector || '']);
        },
      }),

      page_press_key: tool({
        description: 'Press a keyboard key (e.g., "Enter", "Escape", "Tab", "ArrowDown"). Dispatches keydown, keypress, and keyup events.',
        inputSchema: z.object({
          key: z.string().describe('Key to press (e.g., "Enter", "Escape", "Tab", "Space", "ArrowDown")'),
          selector: z.string().optional().describe('CSS selector of element to press key on (optional, uses focused element)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ key, selector, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (k: string, sel: string) => {
            const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLElement;
            if (!el) return { error: sel ? `Element not found: ${sel}` : 'No focused element' };
            if (sel) el.focus();
            const opts = { key: k, code: k, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent('keydown', opts));
            el.dispatchEvent(new KeyboardEvent('keypress', opts));
            el.dispatchEvent(new KeyboardEvent('keyup', opts));
            // Handle Enter on forms
            if (k === 'Enter' && el.closest('form')) {
              const form = el.closest('form');
              form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
            return { success: true, key: k };
          }, [key, selector || '']);
        },
      }),

      page_hover: tool({
        description: 'Hover over an element, triggering mouseenter and mouseover events. Prefer ref from page_snapshot over a CSS selector.',
        inputSchema: z.object({
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed since you looked)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ ref, selector, tabId }) => {
          if (ref) return this.actOnRef(tabId, 'hover', ref);
          if (!selector) return { error: 'Provide either ref or selector' };
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return { error: `Element not found: ${sel}` };
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            return { success: true, tag: el.tagName.toLowerCase() };
          }, [selector]);
        },
      }),

      page_scroll: tool({
        description: 'Scroll the page or a specific element in a direction.',
        inputSchema: z.object({
          direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).describe('Scroll direction'),
          amount: z.number().optional().describe('Scroll amount in pixels (default 500, ignored for top/bottom)'),
          selector: z.string().optional().describe('CSS selector of element to scroll (optional, scrolls the page)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ direction, amount, selector, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (dir: string, px: number, sel: string) => {
            const el = sel ? document.querySelector(sel) : document.documentElement;
            if (!el) return { error: `Element not found: ${sel}` };
            const target = sel ? el : window;
            switch (dir) {
              case 'up': (target as Window).scrollBy ? (target as Window).scrollBy(0, -px) : el.scrollTop -= px; break;
              case 'down': (target as Window).scrollBy ? (target as Window).scrollBy(0, px) : el.scrollTop += px; break;
              case 'left': (target as Window).scrollBy ? (target as Window).scrollBy(-px, 0) : el.scrollLeft -= px; break;
              case 'right': (target as Window).scrollBy ? (target as Window).scrollBy(px, 0) : el.scrollLeft += px; break;
              case 'top': if (sel) { el.scrollTop = 0; } else { window.scrollTo(0, 0); } break;
              case 'bottom': if (sel) { el.scrollTop = el.scrollHeight; } else { window.scrollTo(0, document.body.scrollHeight); } break;
            }
            return { success: true, direction: dir, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
          }, [direction, amount || 500, selector || '']);
        },
      }),

      page_wait_for_selector: tool({
        description: 'Wait for an element matching the selector to appear in the DOM. Polls at 100ms intervals.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector to wait for'),
          timeout: z.number().optional().describe('Timeout in milliseconds (default 5000)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, timeout, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const maxTime = timeout || 5000;
          const startTime = Date.now();
          while (Date.now() - startTime < maxTime) {
            const found = await this.executeOnTab(targetTabId, (sel: string) => {
              return !!document.querySelector(sel);
            }, [selector]);
            if (found) return { success: true, selector, elapsed: Date.now() - startTime };
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return { error: `Timeout waiting for selector: ${selector}`, timeout: maxTime };
        },
      }),

      page_wait_for_text: tool({
        description: 'Wait for specific text to appear on the page. Polls at 100ms intervals.',
        inputSchema: z.object({
          text: z.string().describe('Text to wait for'),
          timeout: z.number().optional().describe('Timeout in milliseconds (default 5000)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ text, timeout, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          const maxTime = timeout || 5000;
          const startTime = Date.now();
          while (Date.now() - startTime < maxTime) {
            const found = await this.executeOnTab(targetTabId, (txt: string) => {
              return document.body.innerText.includes(txt);
            }, [text]);
            if (found) return { success: true, text, elapsed: Date.now() - startTime };
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return { error: `Timeout waiting for text: ${text}`, timeout: maxTime };
        },
      }),

      page_screenshot: tool({
        description: 'Take a screenshot of the currently visible area of the tab. Returns a base64-encoded image data URL.',
        inputSchema: z.object({
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          format: z.enum(['png', 'jpeg']).optional().describe('Image format (default png)'),
          quality: z.number().optional().describe('JPEG quality 0-100 (only for jpeg format)'),
        }),
        execute: async ({ tabId, format, quality }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          // Ensure the tab is active for captureVisibleTab
          const tab = await chrome.tabs.get(targetTabId);
          if (!tab.active) {
            await chrome.tabs.update(targetTabId, { active: true });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const imageFormat = format || 'png';
          const options: { format?: string; quality?: number } = {
            format: imageFormat,
          };
          if (format === 'jpeg' && quality !== undefined) {
            options.quality = quality;
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options as chrome.extensionTypes.ImageDetails);
          const comma = dataUrl.indexOf(',');
          const mimeType = dataUrl.slice(5, comma).split(';')[0] || (imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png');
          return {
            content: [
              { type: 'image', data: comma > 0 ? dataUrl.slice(comma + 1) : dataUrl, mimeType },
              { type: 'text', text: `Screenshot captured (${imageFormat})` },
            ],
            isError: false,
          };
        },
      }),

      page_focus: tool({
        description: 'Focus an element. Prefer ref from page_snapshot over a CSS selector.',
        inputSchema: z.object({
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed since you looked)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ ref, selector, tabId }) => {
          if (ref) return this.actOnRef(tabId, 'focus', ref);
          if (!selector) return { error: 'Provide either ref or selector' };
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return { error: `Element not found: ${sel}` };
            el.focus();
            return { success: true, tag: el.tagName.toLowerCase() };
          }, [selector]);
        },
      }),

      page_check_checkbox: tool({
        description: 'Check or uncheck a checkbox or radio input. Prefer ref from page_snapshot over a CSS selector.',
        inputSchema: z.object({
          ref: z.string().optional().describe('Element ref from page_snapshot (preferred — survives DOM changes)'),
          selector: z.string().optional().describe('CSS selector (fallback; may drift if the DOM changed since you looked)'),
          checked: z.boolean().optional().describe('Whether to check (true) or uncheck (false). Defaults to toggle.'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ ref, selector, checked, tabId }) => {
          if (ref) {
            return this.actOnRef(tabId, 'check-checkbox', ref, {
              checked: checked !== undefined ? checked : null,
            });
          }
          if (!selector) return { error: 'Provide either ref or selector' };
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, shouldCheck: boolean | null) => {
            const el = document.querySelector(sel) as HTMLInputElement;
            if (!el) return { error: `Element not found: ${sel}` };
            if (el.type !== 'checkbox' && el.type !== 'radio') return { error: `Element is not a checkbox/radio: ${el.type}` };
            const newValue = shouldCheck !== null ? shouldCheck : !el.checked;
            el.checked = newValue;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true, checked: el.checked };
          }, [selector, checked !== undefined ? checked : null]);
        },
      }),

      page_list_frames: tool({
        description: 'List all frames (iframes) in a tab with their frame IDs, URLs, and names. Use the returned frameId with other page_* tools to operate on iframe content.',
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
            usage: 'Pass the frameId to other page_* tools to operate on iframe content',
          };
        },
      }),
    };
  }
}

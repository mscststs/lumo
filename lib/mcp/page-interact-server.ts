import { tool } from 'ai';
import { z } from 'zod';
import type { IMcpServer, McpServerInfo, McpServerStatus, McpToolDefinition, AnyTool } from './types';
import { attachedTabs } from './session-store';

/**
 * Page Interaction MCP Server
 * Provides tools for interacting with web page content via chrome.scripting:
 * - DOM reading (get text, HTML, attributes, computed styles)
 * - DOM querying (querySelector, querySelectorAll)
 * - User interaction simulation (click, fill, type, hover, scroll)
 * - Form manipulation (fill form, select options, upload files)
 * - Page snapshots (text content, structured DOM tree)
 * - Wait operations (wait for selector, text)
 * - Screenshot capture
 */
export class PageInteractMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'page-interact',
      name: 'Page Interaction',
      description: 'Page content reading, DOM manipulation, form filling, clicking, and screenshots',
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
   * Execute JavaScript via CDP Runtime.evaluate. Used as fallback when
   * chrome.scripting is blocked by CSP, or when page_evaluate is called
   * with useCDP=true.
   */
  private async evaluateViaCDP(tabId: number, expression: string): Promise<{ success: boolean; result?: unknown; error?: string; note?: string }> {
    // Ensure debugger is attached
    if (!(await attachedTabs.has(tabId))) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Another debugger') && !message.includes('already attached')) {
          return { success: false, error: `Failed to attach debugger: ${message}` };
        }
      }
      await attachedTabs.add(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    }

    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      generatePreview: true,
    }) as { result: { type: string; value?: unknown; description?: string; subtype?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };

    if (result.exceptionDetails) {
      return { success: false, error: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
    }
    return { success: true, result: result.result.value ?? result.result.description ?? null };
  }

  getTools(): McpToolDefinition[] {
    return [
      { name: 'page_evaluate', description: 'Execute JavaScript in the page context. Supports expressions, statement blocks, and top-level await. Automatically falls back to CDP if CSP blocks execution. Use useCDP=true to force CDP mode.', inputSchema: { type: 'object', properties: { code: { type: 'string' }, tabId: { type: 'number' }, useCDP: { type: 'boolean' } }, required: ['code'] } },
      { name: 'page_get_text', description: 'Get the text content of the entire page or a specific element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } } } },
      { name: 'page_get_html', description: 'Get the HTML content of the page or a specific element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, outer: { type: 'boolean' }, tabId: { type: 'number' } } } },
      { name: 'page_query_selector', description: 'Query a single element and return its properties', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_query_selector_all', description: 'Query all matching elements and return their properties', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'number' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_get_attribute', description: 'Get an attribute value of an element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, attribute: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'attribute'] } },
      { name: 'page_get_computed_style', description: 'Get computed style properties of an element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_click', description: 'Click on an element matching the selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_fill', description: 'Fill an input/textarea element with text', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'value'] } },
      { name: 'page_fill_form', description: 'Fill multiple form fields at once', inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } } } }, tabId: { type: 'number' } }, required: ['fields'] } },
      { name: 'page_select_option', description: 'Select an option in a select element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'value'] } },
      { name: 'page_type_text', description: 'Type text character by character into the focused or specified element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, delay: { type: 'number' }, tabId: { type: 'number' } }, required: ['text'] } },
      { name: 'page_press_key', description: 'Press a keyboard key on the page or element', inputSchema: { type: 'object', properties: { key: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['key'] } },
      { name: 'page_hover', description: 'Hover over an element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_scroll', description: 'Scroll the page or an element', inputSchema: { type: 'object', properties: { direction: { type: 'string' }, amount: { type: 'number' }, selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['direction'] } },
      { name: 'page_wait_for_selector', description: 'Wait for an element matching the selector to appear', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, timeout: { type: 'number' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_wait_for_text', description: 'Wait for specific text to appear on the page', inputSchema: { type: 'object', properties: { text: { type: 'string' }, timeout: { type: 'number' }, tabId: { type: 'number' } }, required: ['text'] } },
      { name: 'page_screenshot', description: 'Take a screenshot of the visible tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, format: { type: 'string' }, quality: { type: 'number' } } } },
      { name: 'page_take_snapshot', description: 'Take a structured text snapshot of the page DOM for AI consumption', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, maxDepth: { type: 'number' } } } },
      { name: 'page_focus', description: 'Focus on an element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_check_checkbox', description: 'Check or uncheck a checkbox', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, checked: { type: 'boolean' }, tabId: { type: 'number' } }, required: ['selector'] } },
      { name: 'page_list_frames', description: 'List all frames (iframes) in the page with their IDs', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
    ];
  }

  getAITools(): Record<string, AnyTool> {
    return {
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
              // Fallback to CDP
              const cdpResult = await this.evaluateViaCDP(targetTabId, code);
              return { ...cdpResult, note: 'Executed via CDP fallback due to CSP restriction.' };
            }

            return scriptResult ?? { success: false, error: 'Script execution returned no result' };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // If the scripting API itself failed (e.g., cannot inject into chrome:// pages),
            // try CDP as fallback
            if (errorMsg.includes('Cannot access') || errorMsg.includes('Cannot script') ||
                errorMsg.includes('Extension manifest')) {
              const cdpResult = await this.evaluateViaCDP(targetTabId, code);
              return { ...cdpResult, note: 'Executed via CDP fallback (page not scriptable via chrome.scripting).' };
            }
            return { success: false, error: errorMsg };
          }
        },
      }),

      page_get_text: tool({
        description: 'Get the visible text content of the entire page or a specific element. Uses innerText which preserves line breaks between block elements for better readability.',
        inputSchema: z.object({
          selector: z.string().optional().describe('CSS selector to get text from (optional, defaults to body)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame.'),
        }),
        execute: async ({ selector, tabId, frameId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string) => {
            const el = sel ? document.querySelector(sel) : document.body;
            if (!el) return { error: `Element not found: ${sel}` };
            // Use innerText instead of textContent to preserve line breaks between
            // block elements and respect CSS visibility (hidden elements excluded).
            const text = (el as HTMLElement).innerText?.trim() || '';
            return { text, length: text.length };
          }, [selector || ''], frameId);
        },
      }),

      page_get_html: tool({
        description: 'Get the HTML content of the page or a specific element.',
        inputSchema: z.object({
          selector: z.string().optional().describe('CSS selector (optional, defaults to document root)'),
          outer: z.boolean().optional().describe('If true, return outerHTML; if false, return innerHTML (default false)'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, outer, tabId }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (sel: string, getOuter: boolean) => {
            const el = sel ? document.querySelector(sel) : document.documentElement;
            if (!el) return { error: `Element not found: ${sel}` };
            return { html: getOuter ? el.outerHTML : el.innerHTML };
          }, [selector || '', outer || false]);
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
        description: 'Click on an element matching the CSS selector. Dispatches mousedown, mouseup, and click events.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the element to click'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame.'),
        }),
        execute: async ({ selector, tabId, frameId }) => {
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
        description: 'Fill an input or textarea element with text. Clears existing value first, then sets new value and triggers input/change events.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the input/textarea'),
          value: z.string().describe('Value to fill in'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          frameId: z.number().optional().describe('Frame ID to execute in (use page_list_frames to get frame IDs). Defaults to main frame.'),
        }),
        execute: async ({ selector, value, tabId, frameId }) => {
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
        description: 'Select an option in a <select> element by value.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the select element'),
          value: z.string().describe('Value of the option to select'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, value, tabId }) => {
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
        description: 'Hover over an element, triggering mouseenter and mouseover events.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the element to hover'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, tabId }) => {
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
          const options: { format?: string; quality?: number } = {
            format: format || 'png',
          };
          if (format === 'jpeg' && quality !== undefined) {
            options.quality = quality;
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options as chrome.extensionTypes.ImageDetails);
          return { success: true, dataUrl, format: format || 'png' };
        },
      }),

      page_take_snapshot: tool({
        description: 'Take a structured text snapshot of the page DOM tree. Returns a simplified representation suitable for AI analysis, including interactive elements with their selectors.',
        inputSchema: z.object({
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
          maxDepth: z.number().optional().describe('Maximum DOM depth to traverse (default 8)'),
        }),
        execute: async ({ tabId, maxDepth }) => {
          const targetTabId = await this.getTargetTabId(tabId);
          return this.executeOnTab(targetTabId, (depth: number) => {
            const interactiveElements: Array<{
              selector: string;
              tag: string;
              type?: string;
              text?: string;
              value?: string;
              placeholder?: string;
              role?: string;
              ariaLabel?: string;
            }> = [];

            function getSelector(el: Element): string {
              if (el.id) return `#${el.id}`;
              if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
              if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
              const parent = el.parentElement;
              if (!parent) return el.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
              if (siblings.length === 1) {
                return `${getSelector(parent)} > ${el.tagName.toLowerCase()}`;
              }
              const index = siblings.indexOf(el) + 1;
              return `${getSelector(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
            }

            function traverse(node: Element, currentDepth: number): string {
              if (currentDepth > depth) return '';
              const tag = node.tagName.toLowerCase();
              const interactiveTags = ['a', 'button', 'input', 'textarea', 'select', 'details', 'summary'];
              const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'tab', 'menuitem'];
              const role = node.getAttribute('role');
              const isInteractive = interactiveTags.includes(tag) || 
                (role && interactiveRoles.includes(role)) ||
                node.hasAttribute('onclick') ||
                node.hasAttribute('tabindex');

              if (isInteractive) {
                interactiveElements.push({
                  selector: getSelector(node),
                  tag,
                  type: (node as HTMLInputElement).type || undefined,
                  text: node.textContent?.trim().slice(0, 100) || undefined,
                  value: (node as HTMLInputElement).value || undefined,
                  placeholder: (node as HTMLInputElement).placeholder || undefined,
                  role: role || undefined,
                  ariaLabel: node.getAttribute('aria-label') || undefined,
                });
              }

              let result = '';
              const children = Array.from(node.children);
              if (children.length === 0) {
                const text = node.textContent?.trim();
                if (text) result += text.slice(0, 200);
              } else {
                for (const child of children) {
                  result += traverse(child, currentDepth + 1);
                }
              }
              return result;
            }

            const pageText = traverse(document.body, 0);
            return {
              url: location.href,
              title: document.title,
              textContent: pageText.slice(0, 5000),
              interactiveElements: interactiveElements.slice(0, 100),
              totalInteractiveElements: interactiveElements.length,
            };
          }, [maxDepth || 8]);
        },
      }),

      page_focus: tool({
        description: 'Focus on an element matching the selector.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the element to focus'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, tabId }) => {
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
        description: 'Check or uncheck a checkbox input element.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the checkbox'),
          checked: z.boolean().optional().describe('Whether to check (true) or uncheck (false). Defaults to toggle.'),
          tabId: z.number().optional().describe('Tab ID (optional, defaults to active tab)'),
        }),
        execute: async ({ selector, checked, tabId }) => {
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

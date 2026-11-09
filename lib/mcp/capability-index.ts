/**
 * The capability index — what this browser can do, in one screen.
 *
 * Programmatic mode exposes four tools, so the model's only map of the browser
 * is the system prompt. Without a map every conversation spends two or three
 * steps on `mcp list` → `mcp tools <server>` → `mcp describe <server>.<tool>`
 * before it can open a tab, and pays that again on the next conversation.
 *
 * Two layers, deliberately:
 *
 *  - A static skeleton for the built-ins. `entrypoints/sidepanel/main.tsx`
 *    intentionally does not await `initBuiltinMcpServers()`, so a message sent
 *    right after the panel opens would otherwise see an empty registry. The
 *    skeleton also keeps the prompt prefix identical across turns, which is
 *    what a provider's prefix cache keys on.
 *  - A dynamic tail for servers this build does not know about: user-configured
 *    MCP endpoints, WebMCP pages, approved extension providers. Bounded so an
 *    endpoint exposing hundreds of tools cannot take over the context window.
 *
 * Schemas stay out: `mcp describe <server>.<tool>` prints one on demand. The
 * index costs ~400 tokens where all 31 built-in schemas cost more than ten
 * thousand, which is the line `mcp-command.ts` originally drew — the mistake was
 * dropping tool *names* along with the schemas.
 */

import { mcpRegistry } from './registry';
import type { McpServerState } from './types';

/** Tool names listed for a server the skeleton does not cover. */
const MAX_TOOLS_PER_SERVER = 12;

/** Unknown servers listed before the tail stops growing. */
const MAX_SERVERS = 12;

/** Character ceiling for the dynamic tail. */
const MAX_DYNAMIC_CHARS = 1200;

interface BuiltinToolSpec {
  name: string;
  /** What the tool is for, when its name alone would not settle it. */
  note?: string;
}

/**
 * The built-in servers, as data rather than prose.
 *
 * `tests/prompt-injection.test.ts` compares this list with each server's live
 * `getAITools()`, so a renamed or added tool fails the suite instead of quietly
 * disappearing from the prompt.
 */
const BUILTIN_SERVERS: ReadonlyArray<{ id: string; tools: readonly BuiltinToolSpec[] }> = [
  {
    id: 'browser',
    tools: [
      { name: 'browser_tabs', note: 'list/create/close/update/move/group' },
      { name: 'browser_navigate', note: 'goto/back/forward' },
      { name: 'browser_windows' },
      { name: 'browser_bookmarks' },
      { name: 'browser_history' },
      { name: 'browser_cookies' },
      { name: 'browser_downloads' },
    ],
  },
  {
    id: 'page-interact',
    tools: [
      { name: 'page_read', note: 'page as markdown' },
      { name: 'page_snapshot', note: 'accessibility tree with refs' },
      { name: 'page_click' },
      { name: 'page_fill' },
      { name: 'page_keyboard' },
      { name: 'page_wait' },
      { name: 'page_evaluate' },
      { name: 'page_screenshot' },
      { name: 'page_list_frames' },
    ],
  },
  {
    id: 'file',
    tools: [
      { name: 'file_read' },
      { name: 'file_write' },
      { name: 'file_edit' },
      { name: 'file_patch' },
      { name: 'file_list' },
      { name: 'file_move' },
      { name: 'file_delete' },
      { name: 'file_open_preview' },
      { name: 'file_download' },
    ],
  },
  {
    id: 'network-monitor',
    tools: [
      { name: 'network_requests', note: 'list/get/clear' },
      { name: 'network_rules', note: 'block/redirect/headers' },
    ],
  },
  {
    id: 'devtools-advanced',
    tools: [
      { name: 'debug_session', note: 'attach/detach' },
      { name: 'debug_input' },
      { name: 'debug_emulate' },
      { name: 'debug_console' },
    ],
  },
];

/**
 * Calls that cover what a session usually starts with.
 *
 * Deliberately pipelines-free: these are the calls whose argument shape is not
 * guessable from the tool name, which is what `mcp describe` used to be needed
 * for. Every one of them is runnable as written.
 */
const FREQUENT_CALLS: readonly string[] = [
  `mcp call browser.browser_tabs '{"action":"list"}'`,
  `mcp call browser.browser_tabs '{"action":"create","url":"https://example.com"}'`,
  `mcp call browser.browser_navigate '{"action":"goto","url":"https://example.com"}'`,
  `mcp call page-interact.page_read '{}'`,
  `mcp call page-interact.page_snapshot '{"interactiveOnly":true}'`,
  `mcp call page-interact.page_screenshot '{"scope":"viewport"}'`,
  `mcp call network-monitor.network_requests '{"action":"list"}'`,
];

function renderBuiltinSection(): string {
  const rows = BUILTIN_SERVERS.map(
    (server) =>
      `${server.id} — ${server.tools
        .map((tool) => (tool.note ? `${tool.name} (${tool.note})` : tool.name))
        .join(', ')}`,
  );

  return [
    '## Capabilities',
    '',
    ...rows,
    '',
    '`page_*` and `browser_navigate` act on the active tab unless `tabId` is given.',
    '',
    'Frequent calls:',
    ...FREQUENT_CALLS.map((call) => `  ${call}`),
  ].join('\n');
}

/** The static part of the index, exported for tests and budget checks. */
export const CAPABILITY_INDEX_SKELETON = renderBuiltinSection();

/** Tool names the skeleton covers, per built-in server id. */
export const BUILTIN_SKELETON_TOOLS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    BUILTIN_SERVERS.map((server) => [server.id, server.tools.map((tool) => tool.name)]),
  );

function formatServerRow(state: McpServerState, budget: number): string | undefined {
  const names = state.tools.slice(0, MAX_TOOLS_PER_SERVER).map((tool) => tool.name);
  const rest = state.tools.length - names.length;
  const suffix = rest > 0 ? ` (+${rest} more)` : '';
  // A server that failed or is still connecting is worth saying out loud: the
  // model should not spend a call discovering it.
  const status = state.status === 'connected' ? '' : ` [${state.status}]`;
  const row = `${state.info.id} — ${names.join(', ')}${suffix}${status}`;
  return row.length > budget ? undefined : row;
}

/**
 * Servers the skeleton does not describe.
 *
 * Built-ins are skipped because the skeleton already names them: repeating them
 * would double the cost of the one part of the prompt that never changes.
 */
function formatServerTail(states: McpServerState[]): string {
  const rows: string[] = [];
  let budget = MAX_DYNAMIC_CHARS;

  for (const state of states) {
    if (state.info.builtin) continue;
    if (!state.info.enabled || state.tools.length === 0) continue;
    if (rows.length >= MAX_SERVERS) {
      rows.push('  …');
      break;
    }
    const row = formatServerRow(state, budget);
    if (!row) {
      rows.push('  …');
      break;
    }
    budget -= row.length;
    rows.push(`  ${row}`);
  }

  if (rows.length === 0) return '';
  return ['Other MCP servers (same `mcp` commands):', ...rows].join('\n');
}

function compose(states: McpServerState[]): string {
  const tail = formatServerTail(states);
  return tail ? `${CAPABILITY_INDEX_SKELETON}\n\n${tail}` : CAPABILITY_INDEX_SKELETON;
}

let cached: string | undefined;
let subscribed = false;

function ensureInvalidation(): void {
  if (subscribed) return;
  subscribed = true;
  // The registry notifies on register/unregister/connect, which is exactly when
  // the tail can change. The skeleton never does.
  mcpRegistry.subscribe(() => {
    cached = undefined;
  });
}

/**
 * Render the index.
 *
 * @param states Tool surface to describe. Omit to read the registry (cached until
 *   it changes); pass an explicit list in tests and in callers holding a
 *   snapshot.
 */
export function formatCapabilityIndex(states?: McpServerState[]): string {
  if (states) return compose(states);
  ensureInvalidation();
  cached ??= compose(mcpRegistry.getAllStates());
  return cached;
}

/**
 * What a turn actually puts in front of the model.
 *
 * The prompt is the product's most expensive artefact per token and the one that
 * silently rots: a tool renamed in a server file disappears from the capability
 * index, a section duplicated in two modules doubles its weight in the model's
 * decision. These tests pin the three properties that matter — the index matches
 * the live servers, the assembled prompt keeps its section order, and the
 * programmatic payload stays inside its budget.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserMcpServer } from '@/lib/mcp/browser-server';
import { PageInteractMcpServer } from '@/lib/mcp/page-interact-server';
import { FileMcpServer } from '@/lib/mcp/file-server';
import { NetworkMonitorMcpServer } from '@/lib/mcp/network-monitor-server';
import { DevToolsAdvancedMcpServer } from '@/lib/mcp/devtools-advanced-server';
import { formatCapabilityIndex, CAPABILITY_INDEX_SKELETON, BUILTIN_SKELETON_TOOLS } from '@/lib/mcp/capability-index';
import { buildTurnSystemPrompt } from '@/lib/turn-prompt';
import type { McpServerState } from '@/lib/mcp/types';
import { PROGRAMMATIC_TOOLS_PROMPT } from '@/lib/shell/prompt';
import { SHELL_TOOL_DESCRIPTION } from '@/lib/shell/descriptor';
import {
  composeSystemPrompt,
  resolveSystemPrompt,
  stripLegacyTimestamp,
  DEFAULT_SYSTEM_PROMPT_SETTINGS,
} from '@/lib/system-prompt';
import { formatRuntimeContext, formatTimestamp } from '@/lib/runtime-context';

/**
 * Programmatic mode adds this much text to every request (system sections plus
 * the `sh` description, which also travels as a tool schema).
 *
 * A ceiling, not a target: it exists so a future paragraph is a decision instead
 * of an accident. The capability index bought its ~1400 characters by removing
 * duplicated `mcp` syntax and the eight-line `node` advert, and it should not
 * quietly grow back.
 */
const PROGRAMMATIC_PROMPT_BUDGET = 3200;

function state(
  overrides: Partial<McpServerState> & { id: string },
): McpServerState {
  return {
    info: {
      id: overrides.id,
      name: overrides.id,
      description: '',
      transport: 'builtin',
      builtin: false,
      enabled: true,
    },
    status: 'connected',
    tools: [],
    ...overrides,
  } as McpServerState;
}

describe('capability index', () => {
  it('names the tool of every built-in server', () => {
    const servers = [
      new BrowserMcpServer(),
      new PageInteractMcpServer(),
      new FileMcpServer(),
      new NetworkMonitorMcpServer(),
      new DevToolsAdvancedMcpServer(),
    ];

    for (const server of servers) {
      const id = server.getInfo().id;
      const live = Object.keys(server.getAITools()).sort();
      const declared = [...(BUILTIN_SKELETON_TOOLS[id] ?? [])].sort();
      expect(declared, `skeleton for ${id}`).toEqual(live);
      for (const name of live) {
        expect(CAPABILITY_INDEX_SKELETON).toContain(name);
      }
    }
  });

  it('lists the built-ins once and the unknown servers after them', () => {
    const text = formatCapabilityIndex([
      state({ id: 'browser', tools: [{ name: 'browser_tabs' }] as never }),
      state({
        id: 'stripe',
        tools: [{ name: 'search_customers' }, { name: 'create_refund' }] as never,
      }),
    ]);

    // A built-in server is described by the skeleton, not repeated by the tail.
    expect(text.match(/^browser — /gm)?.length).toBe(1);
    expect(text).toContain('stripe — search_customers, create_refund');
    // Still no schemas.
    expect(text).not.toContain('inputSchema');
  });

  it('marks servers that are not usable yet', () => {
    const text = formatCapabilityIndex([
      state({ id: 'flaky', status: 'error', tools: [{ name: 'ping' }] as never }),
    ]);
    expect(text).toContain('flaky — ping [error]');
  });

  it('bounds the tail so a large server cannot take over the prompt', () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool_${String(index).padStart(2, '0')}`,
    }));
    const text = formatCapabilityIndex([state({ id: 'huge', tools: tools as never })]);

    expect(text).toContain('(+68 more)');
    expect(text).not.toContain('tool_79');
    expect(text.length).toBeLessThan(CAPABILITY_INDEX_SKELETON.length + 1200 + 200);
  });

  it('skips disabled and empty servers', () => {
    const text = formatCapabilityIndex([
      state({
        id: 'off',
        info: {
          id: 'off',
          name: 'off',
          description: '',
          transport: 'builtin',
          builtin: false,
          enabled: false,
        },
        tools: [{ name: 'hidden_tool' }] as never,
      }),
      state({ id: 'empty' }),
    ]);
    expect(text).toBe(CAPABILITY_INDEX_SKELETON);
  });
});

describe('system prompt assembly', () => {
  it('orders the derived sections and keeps the volatile part last', async () => {
    const text = await buildTurnSystemPrompt({
      base: 'BASE',
      programmatic: true,
      injectCurrentTime: true,
      now: new Date(2026, 0, 2, 3, 4, 5),
      readTab: async () => ({ id: 7, title: 'Docs', url: 'https://example.com' }),
    });

    expect(text).toBeDefined();
    expect(text!.startsWith('BASE')).toBe(true);
    expect(text).toMatch(
      /## Capabilities[\s\S]*## Programmatic mode[\s\S]*## Runtime context\nCurrentTime: 2026-01-02 03:04:05/,
    );
    expect(text!.indexOf('## Runtime context')).toBeGreaterThan(text!.indexOf('## Programmatic mode'));
  });

  it('sends only the prompt and the environment when the mode is off', async () => {
    const text = await buildTurnSystemPrompt({
      base: 'BASE',
      programmatic: false,
      injectCurrentTime: false,
      readTab: async () => undefined,
    });

    expect(text).toBe('BASE');
    expect(text).not.toContain('## Capabilities');
  });

  it('keeps section order and drops the empty ones', () => {
    const text = composeSystemPrompt('base', ['## Capabilities', undefined, '## Runtime context']);
    expect(text).toBe('base\n\n## Capabilities\n\n## Runtime context');
    expect(composeSystemPrompt(undefined, [undefined])).toBeUndefined();
  });

  it('sends the user prompt verbatim', () => {
    expect(resolveSystemPrompt(DEFAULT_SYSTEM_PROMPT_SETTINGS)).toBe(
      DEFAULT_SYSTEM_PROMPT_SETTINGS.prompt,
    );
    expect(resolveSystemPrompt(undefined)).toBeUndefined();
    expect(resolveSystemPrompt({ enabled: false, prompt: 'x' })).toBeUndefined();
  });

  it('drops a timestamp frozen into an old conversation snapshot', () => {
    const legacy = 'CurrentTime: 2026-01-02 03:04:05\n\nYou are Lumo.';
    expect(stripLegacyTimestamp(legacy)).toBe('You are Lumo.');
    expect(stripLegacyTimestamp('You are Lumo.')).toBe('You are Lumo.');
    expect(stripLegacyTimestamp(undefined)).toBeUndefined();
    // A prompt that merely mentions the label is the user's own text.
    expect(stripLegacyTimestamp('CurrentTime: mention it once')).toBe(
      'CurrentTime: mention it once',
    );
  });

  it('keeps the volatile facts out of the prompt snapshot', () => {
    const prompt = resolveSystemPrompt(DEFAULT_SYSTEM_PROMPT_SETTINGS) ?? '';
    expect(prompt).not.toContain('CurrentTime');
  });

  it('stays inside the programmatic budget', () => {
    const payload = [
      formatCapabilityIndex([]),
      PROGRAMMATIC_TOOLS_PROMPT,
      SHELL_TOOL_DESCRIPTION,
    ].join('\n\n');
    expect(payload.length).toBeLessThan(PROGRAMMATIC_PROMPT_BUDGET);
  });

  it('recommends a pipeline before a node program', () => {
    // The regression this guards: node was described in eight lines and a
    // pipeline in none, so the model wrote JavaScript for jq-shaped work.
    expect(PROGRAMMATIC_TOOLS_PROMPT).toMatch(/pipeline before writing a program/i);
    expect(PROGRAMMATIC_TOOLS_PROMPT).toMatch(/node is the fallback/i);
    expect(SHELL_TOOL_DESCRIPTION).toMatch(/node -e/);
  });
});

describe('runtime context', () => {
  it('reports the time and the actionable tab id', () => {
    const text = formatRuntimeContext({
      now: new Date(2026, 1, 14, 9, 5, 3),
      tab: { id: 42, title: 'Docs', url: 'https://example.com/docs' },
    });
    expect(text).toContain('CurrentTime: 2026-02-14 09:05:03');
    expect(text).toContain('Active tab: 42 — Docs — https://example.com/docs');
    expect(text).toContain('tabId 42');
  });

  it('omits the time when it is switched off and nothing else is known', () => {
    expect(formatRuntimeContext({ tab: { id: 1 } })).toContain('Active tab: 1');
    expect(formatRuntimeContext({})).toBeUndefined();
  });

  it('formats local time without relying on locale', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
  });
});

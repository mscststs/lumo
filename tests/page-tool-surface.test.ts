/**
 * Tool surface contract for the page-interaction server.
 *
 * The two assertions worth keeping long-term are the name-set equality between
 * `getTools()` and `getAITools()` — the guard against the double-write drift that
 * had already lost `frameId` — and the escape-hatch check, because
 * `page_get_text` / `page_get_html` are the *only* way to read a `chrome://` page
 * and a future cleanup pass would otherwise be tempted to delete them.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PageInteractMcpServer } from '@/lib/mcp/page-interact-server';

const server = new PageInteractMcpServer();
const aiTools = server.getAITools();
const uiTools = server.getTools();

/** Property names in a tool's JSON Schema. */
function schemaKeys(name: string): string[] {
  const tool = uiTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No such tool: ${name}`);
  return Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
}

describe('tool surface', () => {
  it('no longer exposes page_take_snapshot', () => {
    // Its three defects (glued text, JSON-blob pollution, depth truncation) are
    // all fixed by page_snapshot, which is a strict superset. Leaving a tool that
    // is known to produce wrong data only gives the model a chance to pick it.
    expect(Object.keys(aiTools)).not.toContain('page_take_snapshot');
    expect(uiTools.map((tool) => tool.name)).not.toContain('page_take_snapshot');
  });

  it('keeps getTools() and getAITools() in sync', () => {
    // The old hand-written JSON Schema array had already drifted from the zod
    // schemas. Deriving one from the other makes drift impossible; this asserts it.
    expect(uiTools.map((tool) => tool.name).sort()).toEqual(Object.keys(aiTools).sort());
  });

  it('derives UI schemas from the same zod schema the model sees', () => {
    for (const tool of uiTools) {
      const zodSchema = (aiTools[tool.name] as { inputSchema?: unknown }).inputSchema;
      const expected = z.toJSONSchema(zodSchema as z.ZodType, { io: 'input' }) as Record<string, unknown>;
      delete expected.$schema;
      expect(tool.inputSchema).toEqual(expected);
    }
  });

  it('exposes the new content, structure and search tools', () => {
    expect(aiTools).toHaveProperty('page_read');
    expect(aiTools).toHaveProperty('page_snapshot');
    expect(aiTools).toHaveProperty('page_find');
  });

  it('still exposes the escape hatches', () => {
    // These are the only way to read chrome://, the Web Store and extension
    // pages, where no content script can be injected.
    expect(aiTools).toHaveProperty('page_get_text');
    expect(aiTools).toHaveProperty('page_get_html');
  });

  it('marks the escape hatches deprecated and points at the replacement', () => {
    for (const name of ['page_get_text', 'page_get_html']) {
      const description = (aiTools[name] as { description?: string }).description ?? '';
      expect(description).toContain('Deprecated');
      expect(description).toContain('page_read');
    }
  });

  it('gives every tool a non-empty description', () => {
    for (const tool of uiTools) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('offers ref on every element-targeting action tool', () => {
    // A ref is the only handle that survives a DOM change; every action needs one.
    for (const name of [
      'page_click',
      'page_fill',
      'page_hover',
      'page_focus',
      'page_select_option',
      'page_check_checkbox',
    ]) {
      expect(schemaKeys(name)).toContain('ref');
    }
  });

  it('keeps selector optional rather than required on ref-capable tools', () => {
    for (const name of ['page_click', 'page_fill', 'page_hover', 'page_focus']) {
      const schema = uiTools.find((tool) => tool.name === name)!.inputSchema as {
        required?: string[];
      };
      expect(schema.required ?? []).not.toContain('selector');
    }
  });

  it('offers output limits on every page-reading tool', () => {
    for (const name of ['page_read', 'page_snapshot', 'page_find', 'page_get_text', 'page_get_html']) {
      expect(schemaKeys(name)).toContain('maxChars');
      expect(schemaKeys(name)).toContain('offset');
    }
  });

  it('exposes no maxDepth parameter anywhere', () => {
    // Depth-based pruning was the wrong abstraction: DOM depth is unrelated to
    // information density, so no correct default exists (spec §5 D3).
    for (const tool of uiTools) {
      expect(schemaKeys(tool.name)).not.toContain('maxDepth');
    }
  });

  it('reports itself as a builtin server with an updated description', () => {
    const info = server.getInfo();
    expect(info.id).toBe('page-interact');
    expect(info.builtin).toBe(true);
    expect(info.description).toContain('Markdown');
    expect(info.description).toContain('accessibility snapshots');
  });
});

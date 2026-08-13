/**
 * Tool surface contract for the page-interaction server.
 *
 * Asserts the tool set after the consolidation refactor:
 * - 9 unified tools: page_read, page_snapshot, page_evaluate, page_click,
 *   page_fill, page_keyboard, page_wait, page_screenshot, page_list_frames
 * - No legacy tools remain (page_get_text, page_get_html, page_find, etc.)
 * - getTools() and getAITools() stay in sync (derived, not hand-written)
 */

import { describe, expect, it } from 'vitest';
import { PageInteractMcpServer } from '@/lib/mcp/page-interact-server';

const server = new PageInteractMcpServer();
const aiTools = server.getAITools();
const uiTools = server.getTools();

describe('tool surface', () => {
  it('exposes exactly the expected tool set', () => {
    const expected = [
      'page_read',
      'page_snapshot',
      'page_evaluate',
      'page_click',
      'page_fill',
      'page_keyboard',
      'page_wait',
      'page_screenshot',
      'page_list_frames',
    ].sort();
    expect(Object.keys(aiTools).sort()).toEqual(expected);
    expect(uiTools.map((t) => t.name).sort()).toEqual(expected);
  });

  it('no longer exposes legacy tools', () => {
    const removed = [
      'page_take_snapshot',
      'page_get_text',
      'page_get_html',
      'page_find',
      'page_query_selector',
      'page_query_selector_all',
      'page_get_attribute',
      'page_get_computed_style',
      'page_hover',
      'page_focus',
      'page_scroll',
      'page_type_text',
      'page_press_key',
      'page_fill_form',
      'page_select_option',
      'page_check_checkbox',
      'page_wait_for_selector',
      'page_wait_for_text',
    ];
    for (const name of removed) {
      expect(Object.keys(aiTools)).not.toContain(name);
      expect(uiTools.map((t) => t.name)).not.toContain(name);
    }
  });

  it('keeps getTools() and getAITools() in sync', () => {
    expect(uiTools.map((tool) => tool.name).sort()).toEqual(Object.keys(aiTools).sort());
  });

  it('gives every tool a non-empty description', () => {
    for (const tool of uiTools) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('page_click offers ref as a parameter', () => {
    const tool = uiTools.find((t) => t.name === 'page_click')!;
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    expect(props).toContain('ref');
  });

  it('page_snapshot includes filter capability (absorbed page_find)', () => {
    const tool = uiTools.find((t) => t.name === 'page_snapshot')!;
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    expect(props).toContain('filter');
    expect(props).toContain('filterContext');
  });

  it('page_fill uses object schema with type parameter', () => {
    const tool = uiTools.find((t) => t.name === 'page_fill')!;
    const schema = tool.inputSchema as Record<string, unknown>;
    // Flat object schema with type field as enum
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('type');
  });

  it('page_wait uses a JS condition instead of selector/text split', () => {
    const tool = uiTools.find((t) => t.name === 'page_wait')!;
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    expect(props).toContain('condition');
    expect(props).not.toContain('selector');
    expect(props).not.toContain('text');
  });

  it('page_screenshot supports viewport, fullpage, and element scopes', () => {
    const desc = (aiTools['page_screenshot'] as { description?: string }).description ?? '';
    expect(desc).toContain('viewport');
    expect(desc).toContain('fullpage');
    expect(desc).toContain('element');
  });

  it('page_read offers output limits', () => {
    const tool = uiTools.find((t) => t.name === 'page_read')!;
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    expect(props).toContain('maxChars');
    expect(props).toContain('offset');
  });

  it('page_snapshot offers output limits', () => {
    const tool = uiTools.find((t) => t.name === 'page_snapshot')!;
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    expect(props).toContain('maxChars');
    expect(props).toContain('offset');
  });

  it('reports itself as a builtin server with updated description', () => {
    const info = server.getInfo();
    expect(info.id).toBe('page-interact');
    expect(info.builtin).toBe(true);
    expect(info.description).toContain('Markdown');
    expect(info.description).toContain('accessibility snapshots');
  });
});

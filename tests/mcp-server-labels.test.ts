/**
 * Localization contract for the built-in MCP server list.
 *
 * `getInfo()` hardcodes English because it runs in the background worker, where
 * there is no i18n instance. The settings UI rendered those strings directly, so
 * every `options.mcp.builtinServers.*` translation was a dead key and the server
 * list stayed English under a Chinese UI.
 *
 * The property that matters is not that a lookup succeeds today, but that it
 * cannot silently start failing: a server id renamed without its key renamed
 * would fall back to English, which looks like working software. These tests
 * drive the real `getInfo()` of every registered built-in server, so adding a
 * server or renaming an id fails here rather than in the UI.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import {
  serverDisplayName,
  serverDisplayDescription,
  LOCALIZED_BUILTIN_SERVER_IDS,
} from '@/lib/mcp/server-labels';
import { BrowserMcpServer } from '@/lib/mcp/browser-server';
import { PageInteractMcpServer } from '@/lib/mcp/page-interact-server';
import { NetworkMonitorMcpServer } from '@/lib/mcp/network-monitor-server';
import { DevToolsAdvancedMcpServer } from '@/lib/mcp/devtools-advanced-server';
import { FileMcpServer } from '@/lib/mcp/file-server';

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

/** Every built-in server that appears in the settings list. */
const BUILTIN_SERVERS = [
  new BrowserMcpServer(),
  new PageInteractMcpServer(),
  new NetworkMonitorMcpServer(),
  new DevToolsAdvancedMcpServer(),
  new FileMcpServer(),
].map((s) => s.getInfo());

const t = (key: string, options?: Record<string, unknown>): string =>
  String(i18next.t(key, options as never));

describe('built-in server label coverage', () => {
  it('has a translation key for every built-in server in the settings list', () => {
    expect(BUILTIN_SERVERS.map((i) => i.id).sort()).toEqual(
      [...LOCALIZED_BUILTIN_SERVER_IDS].sort(),
    );
  });

  it.each(['en', 'zh'] as const)('resolves every name and description in %s', async (lng) => {
    await i18next.changeLanguage(lng);
    for (const info of BUILTIN_SERVERS) {
      const name = serverDisplayName(t, info);
      const description = serverDisplayDescription(t, info);
      expect(name).not.toContain('options.mcp');
      expect(description).not.toContain('options.mcp');
      expect(name.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it('actually translates rather than echoing the hardcoded English', async () => {
    await i18next.changeLanguage('zh');
    for (const info of BUILTIN_SERVERS) {
      // The regression this guards: rendering `info.name` looked correct in
      // English and was wrong in every other language.
      expect(serverDisplayName(t, info)).not.toBe(info.name);
      expect(serverDisplayDescription(t, info)).not.toBe(info.description);
    }
  });

  it('uses the English translation, not the raw getInfo string, for en', async () => {
    await i18next.changeLanguage('en');
    const file = BUILTIN_SERVERS.find((i) => i.id === 'file')!;
    expect(serverDisplayName(t, file)).toBe(en.options.mcp.builtinServers.file);
  });
});

describe('fallback behaviour', () => {
  it('falls back to the server name for a non-builtin server', async () => {
    await i18next.changeLanguage('zh');
    const external = { id: 'ext-1', name: 'My Server', description: 'User supplied' };
    expect(serverDisplayName(t, external)).toBe('My Server');
    expect(serverDisplayDescription(t, external)).toBe('User supplied');
  });

  it('falls back for a builtin id that has no translation key, e.g. webmcp', async () => {
    await i18next.changeLanguage('zh');
    const webmcp = {
      id: 'webmcp',
      name: 'WebMCP',
      description: 'Tools discovered from web pages via WebMCP protocol',
      builtin: true,
    };
    expect(serverDisplayName(t, webmcp)).toBe('WebMCP');
    expect(serverDisplayDescription(t, webmcp)).toBe(webmcp.description);
  });
});

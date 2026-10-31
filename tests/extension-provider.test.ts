import { describe, expect, it } from 'vitest';

const { DEFAULT_MCP_SETTINGS, normalizeMcpSettings } = await import('@/lib/mcp/settings');
const { isExtensionId, isProbeResponse } = await import('@/lib/mcp/extension-protocol');

const EXT_A = 'a'.repeat(32);

describe('mcp settings normalization', () => {
  it('fills fields added after the first release', () => {
    expect(normalizeMcpSettings(undefined)).toEqual(DEFAULT_MCP_SETTINGS);
    const migrated = normalizeMcpSettings({
      servers: [],
      disabledBuiltins: [],
      webmcpEnabled: false,
    });
    expect(migrated.extensionProviders).toEqual([]);
  });

  it('drops the retired injectInstructions field', () => {
    // It moved to the system prompt settings; a stale record must not survive a
    // normalize round-trip into an exported config.
    const normalized = normalizeMcpSettings({ injectInstructions: false } as never);
    expect('injectInstructions' in normalized).toBe(false);
  });

  it('drops invalid or duplicate extension IDs', () => {
    const result = normalizeMcpSettings({
      extensionProviders: [
        { id: EXT_A, enabled: true },
        { id: EXT_A, enabled: false },
        { id: 'bad' },
        { id: 'b'.repeat(32) },
      ],
    } as never);
    expect(result.extensionProviders).toEqual([
      { id: EXT_A, enabled: true },
      { id: 'b'.repeat(32), enabled: true },
    ]);
  });
});

describe('probe response guard', () => {
  it('accepts a shaped response and rejects garbage', () => {
    expect(isProbeResponse({ ok: true })).toBe(true);
    expect(isProbeResponse({ ok: 'yes' })).toBe(false);
    expect(isProbeResponse(null)).toBe(false);
    expect(isExtensionId(EXT_A)).toBe(true);
    expect(isExtensionId('z'.repeat(32))).toBe(false);
  });
});

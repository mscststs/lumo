import { describe, it, expect } from 'vitest';
import { STORAGE_FIELDS, EXPORTABLE_KEYS, type StorageSchema } from '@/store/storage-schema';
import { normalizeCommandSettings } from '@/lib/slash-commands';

describe('commandSettings in the storage registry', () => {
  it('is exportable and normalized on import', () => {
    expect(EXPORTABLE_KEYS).toContain('commandSettings');
    const raw: unknown = {
      userCommands: [{ name: 'fy', phrase: 'x' }],
    };
    const normalized = normalizeCommandSettings(raw);
    expect(normalized.userCommands[0]?.name).toBe('fy');
  });
});

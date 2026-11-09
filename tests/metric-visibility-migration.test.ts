/**
 * The single `showStepMetrics` switch was split into two independent metric
 * visibility values. Configs written by the older build (and hand-edited
 * exports) still carry it, so the storage normaliser must seed both new values
 * from it rather than silently re-enabling a metric the user turned off.
 */
import { describe, it, expect } from 'vitest';
import { STORAGE_FIELDS } from '@/store/storage-schema';
import type { UISettings } from '@/types';

const normalize = STORAGE_FIELDS.uiSettings.normalize!;
const base = STORAGE_FIELDS.uiSettings.defaultValue;

function withLegacy(extra: Partial<UISettings> & { showStepMetrics?: boolean }): UISettings {
  // A legacy record predates the split: the two new fields are absent, not
  // present with their defaults. Remove them before adding the legacy switch.
  const { ttftVisibility: _ttft, throughputVisibility: _throughput, ...legacy } =
    base;
  return normalize({ ...legacy, ...extra } as unknown as UISettings) as UISettings;
}

describe('metric visibility migration', () => {
  it('defaults both metrics to streaming', () => {
    const settings = withLegacy({});
    expect(settings.ttftVisibility).toBe('streaming');
    expect(settings.throughputVisibility).toBe('streaming');
  });

  it('maps the legacy off switch to both metrics hidden', () => {
    const settings = withLegacy({ showStepMetrics: false });
    expect(settings.ttftVisibility).toBe('hidden');
    expect(settings.throughputVisibility).toBe('hidden');
  });

  it('lets an explicit new value win over the legacy switch', () => {
    const settings = withLegacy({ showStepMetrics: false, ttftVisibility: 'streaming' });
    expect(settings.ttftVisibility).toBe('streaming');
    expect(settings.throughputVisibility).toBe('hidden');
  });

  it('falls back to streaming for unknown stored values', () => {
    const settings = normalize({
      ...base,
      ttftVisibility: 'sometimes',
      throughputVisibility: 42,
    } as unknown as UISettings) as UISettings;
    expect(settings.ttftVisibility).toBe('streaming');
    expect(settings.throughputVisibility).toBe('streaming');
  });
});

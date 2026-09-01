/**
 * Tool-surface gating for non-vision models.
 *
 * `page_screenshot` is the only vision-only tool. It must stay available when
 * either the model natively sees images or OCR can translate the screenshot to
 * text; otherwise it is removed from the tool set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterToolsByVision, isOcrAvailable, VISION_ONLY_TOOLS } from '@/lib/image-projection';
import { storage } from '@/store/storage';
import type { OcrSettings, ProviderConfig } from '@/types';

// `isOcrAvailable` reads through `storage`, mocked below and adjusted per test.
vi.mock('@/store/storage', () => ({
  storage: {
    getOcrSettings: vi.fn(async () => ocrSettings),
    getProviders: vi.fn(async () => providers),
  },
}));

let ocrSettings: OcrSettings;
let providers: ProviderConfig[];

const p1 = (models: ProviderConfig['models'] = []): ProviderConfig => ({
  id: 'p1',
  name: 'P1',
  type: 'openai-chat',
  apiKey: 'k',
  models,
});

describe('filterToolsByVision', () => {
  const tools = {
    page_read: { description: 'read' },
    page_screenshot: { description: 'screenshot' },
    page_click: { description: 'click' },
  };

  it('keeps every tool when the model can consume images', () => {
    expect(filterToolsByVision(tools, true)).toEqual(tools);
  });

  it('drops vision-only tools when the model cannot consume images', () => {
    const filtered = filterToolsByVision(tools, false);
    expect(Object.keys(filtered)).toEqual(['page_read', 'page_click']);
    expect(filtered).not.toHaveProperty('page_screenshot');
  });

  it('only ever treats page_screenshot as vision-only', () => {
    expect([...VISION_ONLY_TOOLS]).toEqual(['page_screenshot']);
  });
});

describe('isOcrAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ocrSettings = { enabled: false, providerId: '', modelId: '', prompt: '' };
    providers = [];
  });

  it('is false when OCR is disabled', async () => {
    await expect(isOcrAvailable()).resolves.toBe(false);
  });

  it('is false when OCR is enabled but no model is configured', async () => {
    ocrSettings = { ...ocrSettings, enabled: true, providerId: 'p1', modelId: 'm1' };
    await expect(isOcrAvailable()).resolves.toBe(false);
  });

  it('is false when the configured provider or model no longer exists', async () => {
    ocrSettings = { ...ocrSettings, enabled: true, providerId: 'missing', modelId: 'm1' };
    providers = [p1([{ id: 'm1', modelId: 'm1', displayName: 'M1', isVision: true }])];
    await expect(isOcrAvailable()).resolves.toBe(false);
  });

  it('is true when OCR is enabled and the provider/model resolve', async () => {
    ocrSettings = { ...ocrSettings, enabled: true, providerId: 'p1', modelId: 'm1' };
    providers = [p1([{ id: 'm1', modelId: 'm1', displayName: 'M1', isVision: true }])];
    await expect(isOcrAvailable()).resolves.toBe(true);
  });

  it('is false when reading settings throws', async () => {
    vi.mocked(storage.getOcrSettings).mockRejectedValueOnce(new Error('boom'));
    await expect(isOcrAvailable()).resolves.toBe(false);
  });
});

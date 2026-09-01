import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filePreviewUrl, openFilePreview } from '@/lib/file-preview-tab';

describe('file preview tabs', () => {
  const tabsQuery = vi.fn();
  const tabsUpdate = vi.fn();
  const tabsCreate = vi.fn();
  const windowsUpdate = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://test${path}`,
      },
      tabs: {
        query: tabsQuery,
        update: tabsUpdate,
        create: tabsCreate,
      },
      windows: {
        update: windowsUpdate,
      },
    });
    tabsQuery.mockReset();
    tabsUpdate.mockReset().mockResolvedValue({});
    tabsCreate.mockReset().mockResolvedValue({
      id: 42,
      windowId: 7,
      url: filePreviewUrl('demo.ts'),
    });
    windowsUpdate.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a preview tab when the file is not already open', async () => {
    tabsQuery.mockResolvedValue([]);

    const result = await openFilePreview('demo.ts');

    expect(result.reused).toBe(false);
    expect(result.url).toBe('chrome-extension://test/preview.html?file=demo.ts');
    expect(tabsQuery).toHaveBeenCalledWith({ url: result.url });
    expect(tabsCreate).toHaveBeenCalledWith({ url: result.url, active: true });
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('focuses the existing preview tab instead of creating another one', async () => {
    const url = filePreviewUrl('demo.ts');
    tabsQuery.mockResolvedValue([{ id: 9, windowId: 3, url }]);

    const result = await openFilePreview('demo.ts');

    expect(result).toMatchObject({ url, reused: true, tab: { id: 9, windowId: 3 } });
    expect(tabsUpdate).toHaveBeenCalledWith(9, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(3, { focused: true });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('keeps different files in different preview tabs', async () => {
    tabsQuery.mockResolvedValue([]);

    await openFilePreview('one.ts');
    await openFilePreview('two.ts');

    expect(tabsCreate).toHaveBeenNthCalledWith(1, {
      url: filePreviewUrl('one.ts'),
      active: true,
    });
    expect(tabsCreate).toHaveBeenNthCalledWith(2, {
      url: filePreviewUrl('two.ts'),
      active: true,
    });
  });

  it('serializes concurrent requests for the same file', async () => {
    let resolveQuery: ((tabs: chrome.tabs.Tab[]) => void) | undefined;
    tabsQuery.mockImplementation(
      () => new Promise<chrome.tabs.Tab[]>((resolve) => {
        resolveQuery = resolve;
      }),
    );

    const first = openFilePreview('demo.ts');
    const second = openFilePreview('demo.ts');

    expect(tabsQuery).toHaveBeenCalledTimes(1);
    resolveQuery!([]);

    const results = await Promise.all([first, second]);

    expect(results[0]).toEqual(results[1]);
    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });
});

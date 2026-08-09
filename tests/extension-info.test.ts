/**
 * Release channel detection.
 *
 * The channel is what tells a bug report apart: the Web Store build trails the
 * repository, the Actions build is current but never updates itself, and both can
 * be installed side by side as separate extensions. The published extension id is
 * the only thing available at runtime that distinguishes them, so this pins the
 * mapping — including the degenerate cases, because the about page renders in
 * contexts (component tests, a broken `chrome` global) where the id is missing and
 * a throw there would take the whole page down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHROME_STORE_ID,
  CHROME_STORE_URL,
  getExtensionId,
  getExtensionVersion,
  getReleaseChannel,
} from '@/lib/extension-info';

/** Install a `chrome` global exposing just what extension-info reads. */
function stubRuntime(runtime: unknown) {
  vi.stubGlobal('chrome', { runtime });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getReleaseChannel', () => {
  it('reports the published id as the store build', () => {
    stubRuntime({ id: CHROME_STORE_ID, getManifest: () => ({ version: '1.0.6' }) });
    expect(getReleaseChannel()).toBe('store');
    expect(getExtensionVersion()).toBe('1.0.6');
  });

  it('reports any other id as a github build', () => {
    // The key of an unpacked build is derived from its directory, so this is the
    // shape both the Actions artifact and `wxt dev` take.
    stubRuntime({ id: 'abcdefghijklmnopabcdefghijklmnop', getManifest: () => ({ version: '1.0.6' }) });
    expect(getReleaseChannel()).toBe('github');
  });

  it('falls back to a github build when there is no chrome global', () => {
    vi.stubGlobal('chrome', undefined);
    expect(getReleaseChannel()).toBe('github');
    expect(getExtensionId()).toBe('');
    expect(getExtensionVersion()).toBe('');
  });

  it('survives a runtime without getManifest', () => {
    stubRuntime({ id: CHROME_STORE_ID });
    expect(getExtensionVersion()).toBe('');
    expect(getReleaseChannel()).toBe('store');
  });
});

describe('links', () => {
  it('points the store link at the published listing', () => {
    expect(CHROME_STORE_URL).toContain(CHROME_STORE_ID);
  });
});

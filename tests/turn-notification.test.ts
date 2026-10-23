// @vitest-environment jsdom
/**
 * The completion-notification setting packs four modes into one stored string,
 * so the encoding has to be safe on both ends: an unknown/legacy value must read
 * as `never` — never as a mode the user did not opt into — `away` must mean
 * "the panel document is not visible", and `long` must key off elapsed time
 * alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_TURN_NOTIFICATION,
  LONG_TURN_NOTIFICATION_THRESHOLD_MS,
  TURN_NOTIFICATION_MODES,
  normalizeTurnNotification,
  shouldNotifyTurnComplete,
} from '@/lib/turn-notification';
import { notifyTurnComplete } from '@/lib/turn-notifier';
import { TURN_NOTIFICATION_ID } from '@/lib/constants';

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

describe('normalizeTurnNotification', () => {
  it('falls back to never for a value that was never stored', () => {
    // An install that predates this setting, or a hand-edited export.
    expect(normalizeTurnNotification(undefined)).toBe('never');
    expect(normalizeTurnNotification(null)).toBe('never');
    expect(normalizeTurnNotification('bogus')).toBe(DEFAULT_TURN_NOTIFICATION);
  });

  it('keeps every mode the dropdown can produce', () => {
    for (const mode of TURN_NOTIFICATION_MODES) {
      expect(normalizeTurnNotification(mode)).toBe(mode);
    }
  });
});

describe('shouldNotifyTurnComplete', () => {
  afterEach(() => setVisibility('visible'));

  it('never notifies in never mode', () => {
    setVisibility('hidden');
    expect(shouldNotifyTurnComplete('never')).toBe(false);
  });

  it('always notifies in always mode, visible or not', () => {
    setVisibility('visible');
    expect(shouldNotifyTurnComplete('always')).toBe(true);
    setVisibility('hidden');
    expect(shouldNotifyTurnComplete('always')).toBe(true);
  });

  it('notifies in away mode only while the panel is not visible', () => {
    setVisibility('visible');
    expect(shouldNotifyTurnComplete('away')).toBe(false);
    setVisibility('hidden');
    expect(shouldNotifyTurnComplete('away')).toBe(true);
  });

  it('notifies in long mode only once the turn crosses the threshold', () => {
    // Visibility is irrelevant to this mode — the point is the duration alone.
    setVisibility('visible');
    expect(shouldNotifyTurnComplete('long', LONG_TURN_NOTIFICATION_THRESHOLD_MS - 1)).toBe(false);
    expect(shouldNotifyTurnComplete('long', LONG_TURN_NOTIFICATION_THRESHOLD_MS)).toBe(true);
    expect(shouldNotifyTurnComplete('long', LONG_TURN_NOTIFICATION_THRESHOLD_MS * 3)).toBe(true);
  });

  it('treats an unmeasured duration as too short for long mode', () => {
    expect(shouldNotifyTurnComplete('long')).toBe(false);
  });
});

describe('notifyTurnComplete', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as unknown as { chrome: any };
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue(TURN_NOTIFICATION_ID);
    g.chrome = {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
      notifications: { create },
    };
    setVisibility('visible');
  });

  afterEach(() => {
    setVisibility('visible');
  });

  it('does not touch the notifications API in never mode', async () => {
    await notifyTurnComplete('never');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not notify in away mode while the panel is visible', async () => {
    await notifyTurnComplete('away', { title: 'Task' });
    expect(create).not.toHaveBeenCalled();
  });

  it('stays silent in long mode for a turn under the threshold', async () => {
    await notifyTurnComplete('long', {
      title: 'Task',
      elapsedMs: LONG_TURN_NOTIFICATION_THRESHOLD_MS - 1,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('notifies in long mode for a slow turn even while the panel is visible', async () => {
    await notifyTurnComplete('long', {
      title: 'Task',
      elapsedMs: LONG_TURN_NOTIFICATION_THRESHOLD_MS,
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [, options] = create.mock.calls[0]!;
    expect(options.message).toContain('Task');
  });

  it('sends a basic notification with the required fields', async () => {
    await notifyTurnComplete('always', { title: 'Research task' });
    expect(create).toHaveBeenCalledTimes(1);
    const [id, options] = create.mock.calls[0]!;
    expect(id).toBe(TURN_NOTIFICATION_ID);
    expect(options).toMatchObject({
      type: 'basic',
      iconUrl: 'chrome-extension://test/icon/128.png',
    });
    expect(options.title).toBeTruthy();
    expect(options.message).toContain('Research task');
  });

  it('uses the failure copy for a failed turn', async () => {
    await notifyTurnComplete('always', { title: 'Task', failed: true });
    const [, options] = create.mock.calls[0]!;
    // Distinguishable from the success copy, and still names the conversation.
    expect(options.message).toContain('Task');
    expect(options.message.toLowerCase()).toContain('fail');
  });

  it('degrades to a no-op when the notifications API is unavailable', async () => {
    g.chrome = { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } };
    await expect(notifyTurnComplete('always')).resolves.toBeUndefined();
  });

  it('swallows a rejected create so chat cannot be affected', async () => {
    create.mockRejectedValue(new Error('notifications disabled'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyTurnComplete('always')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

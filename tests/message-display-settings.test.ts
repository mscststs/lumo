// @vitest-environment jsdom
/**
 * Display-setting resolution is shared by the chat list and the bubble, so the
 * partial-record behaviour is pinned here: an install predating a switch must
 * land on the shipped default, and only an explicit `false` disables one.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/store/storage', () => ({ storage: { getUISettings: async () => ({}) } }));
vi.mock('@/store/useStorageWatch', () => ({ useStorageWatch: () => {} }));

const { resolveMessageDisplaySettings } = await import(
  '@/components/chat/useMessageDisplaySettings'
);

const ALL_VISIBLE = { copy: 'all', regenerate: 'show', delete: 'all', usage: 'show', time: 'all' };

describe('resolveMessageDisplaySettings', () => {
  it('fills every missing field with the shipped default', () => {
    expect(resolveMessageDisplaySettings(undefined)).toEqual({
      toolbar: ALL_VISIBLE,
      autoCollapseReasoning: true,
      showTtft: true,
      showThroughput: true,
    });
  });

  // An install written before the timestamp existed carries the other four
  // fields only. Reading it as-is would hand the bubble `time: undefined`,
  // which its role check treats as hidden.
  it('seeds a predating toolbar record with the timestamp default', () => {
    const legacy = {
      messageToolbar: { copy: 'hidden', regenerate: 'show', delete: 'user', usage: 'show' },
    } as unknown as Parameters<typeof resolveMessageDisplaySettings>[0];

    expect(resolveMessageDisplaySettings(legacy).toolbar).toEqual({
      copy: 'hidden',
      regenerate: 'show',
      delete: 'user',
      usage: 'show',
      time: 'all',
    });
  });

  it('hides only the metric whose visibility is explicitly hidden', () => {
    expect(
      resolveMessageDisplaySettings({
        messageToolbar: {
          copy: 'hidden',
          regenerate: 'hidden',
          delete: 'hidden',
          usage: 'hidden',
          time: 'hidden',
        },
        autoCollapseReasoning: false,
        ttftVisibility: 'hidden',
        throughputVisibility: 'streaming',
      }),
    ).toEqual({
      toolbar: {
        copy: 'hidden',
        regenerate: 'hidden',
        delete: 'hidden',
        usage: 'hidden',
        time: 'hidden',
      },
      autoCollapseReasoning: false,
      showTtft: false,
      showThroughput: true,
    });
  });
});

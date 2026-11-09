/**
 * Message timestamps are CLDR data, not copy — these pin the buckets and the
 * absolute fallback a message crosses after a day.
 *
 * `now` is fixed rather than read from the clock so the assertions never race a
 * minute boundary.
 */
import { describe, it, expect } from 'vitest';
import { formatMessageTime, formatMessageTimeTitle } from '@/lib/message-time';

// Local wall clock on purpose: the absolute fallback renders in the user's
// timezone, so a UTC literal would put the expected date off by one in TZs
// far from UTC.
const NOW = new Date(2026, 2, 5, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatMessageTime', () => {
  it('renders anything under a minute as "now"', () => {
    expect(formatMessageTime(NOW - 5_000, NOW, 'en-US')).toBe('now');
    expect(formatMessageTime(NOW - 5_000, NOW, 'zh-CN')).toBe('现在');
  });

  it('counts minutes under an hour', () => {
    expect(formatMessageTime(NOW - 3 * MINUTE, NOW, 'en-US')).toBe('3 minutes ago');
    expect(formatMessageTime(NOW - 3 * MINUTE, NOW, 'zh-CN')).toBe('3分钟前');
  });

  it('counts hours under a day', () => {
    expect(formatMessageTime(NOW - 5 * HOUR, NOW, 'en-US')).toBe('5 hours ago');
    expect(formatMessageTime(NOW - 5 * HOUR, NOW, 'zh-CN')).toBe('5小时前');
  });

  it('switches to an absolute date and time after a day', () => {
    expect(formatMessageTime(NOW - 2 * DAY, NOW, 'en-US')).toContain('Mar 3');
    expect(formatMessageTime(NOW - 2 * DAY, NOW, 'en-US')).toContain('12:00');
    expect(formatMessageTime(NOW - 2 * DAY, NOW, 'zh-CN')).toContain('3月3日');
  });

  it('adds the year only when it is not the current one', () => {
    const inYear = formatMessageTime(NOW - 40 * DAY, NOW, 'en-US');
    expect(inYear).not.toContain('2026');

    const lastYear = formatMessageTime(new Date(2025, 10, 20, 9, 30).getTime(), NOW, 'en-US');
    expect(lastYear).toContain('2025');
    expect(lastYear).toContain('Nov 20');
  });

  it('handles a future timestamp (clock skew) with the same buckets', () => {
    expect(formatMessageTime(NOW + 3 * MINUTE, NOW, 'en-US')).toBe('in 3 minutes');
  });
});

describe('formatMessageTimeTitle', () => {
  it('exposes the full localised date and time', () => {
    const title = formatMessageTimeTitle(NOW, 'en-US');
    expect(title).toContain('March');
    expect(title).toContain('2026');
    expect(title).toContain('12:00');
  });
});

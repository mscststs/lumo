// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { tokens?: string }) => `${key}|${opts?.tokens ?? ''}`,
  }),
}));

const { CompactionNotice } = await import('@/components/chat/CompactionNotice');

describe('CompactionNotice', () => {
  it('names the retained-token budget that was not exceeded', () => {
    const { container } = render(
      <CompactionNotice notice={{ kind: 'nothing-to-compact', keepRecentTokens: 20000 }} />,
    );
    expect(container.textContent).toContain('sidebar.compactNothing');
    expect(container.textContent).toContain('20K');
  });

  it('renders nothing when there is no notice', () => {
    const { container } = render(<CompactionNotice notice={null} />);
    expect(container.textContent).toBe('');
  });
});

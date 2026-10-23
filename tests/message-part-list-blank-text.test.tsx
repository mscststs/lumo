// @vitest-environment jsdom
/**
 * Blank text parts between tool calls.
 *
 * A provider commonly opens a step with a whitespace-only text delta (usually
 * `"\n"`) before it issues a tool call, and the SDK assembles that into a real
 * `text` part. The renderer used to guard on `!part.text` only, so `"\n"` slipped
 * through and became an apparently empty `.sd-message-response` block between two
 * tool calls. `MessageContent` is a `gap-1` flex column, so the empty block still
 * contributed a gap above and below — the space between tool calls looked uneven
 * for no visible reason.
 *
 * These pin the fix: a part with no printable character renders nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ChatMessagePart } from '@/types';

// Labels are asserted through their i18n keys, so the test does not restate the
// copy and stays valid when the wording changes.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { MessagePartList } = await import('@/components/chat/MessagePartList');

/** A settled tool part, shaped like the SDK's `dynamic-tool` part. */
function toolPart(toolCallId: string): ChatMessagePart {
  return {
    type: 'dynamic-tool',
    toolName: 'page_screenshot',
    toolCallId,
    state: 'output-available',
    input: { fullPage: true },
    output: { content: [], isError: false },
  } as unknown as ChatMessagePart;
}

describe('blank text parts between tool calls', () => {
  it.each(['', '\n', '\n\n', '   ', '\t'])(
    'renders nothing for a %j text part',
    (text) => {
      const parts: ChatMessagePart[] = [
        toolPart('call-1'),
        { type: 'text', text, state: 'done' } as ChatMessagePart,
        toolPart('call-2'),
      ];

      const { container } = render(<MessagePartList parts={parts} />);

      // The empty `.sd-message-response` block is the whole complaint: it is
      // what adds the extra gap between the two tool calls.
      expect(container.querySelector('.sd-message-response')).toBeNull();
      // Both tool calls must still be there — the fix must not collapse real
      // content along with the blank part.
      expect(container.querySelectorAll('[data-state]')).not.toHaveLength(0);
    },
  );

  it('still renders a text part that has printable content', () => {
    const parts: ChatMessagePart[] = [
      { type: 'text', text: 'Here is the result.', state: 'done' } as ChatMessagePart,
    ];

    const { container } = render(<MessagePartList parts={parts} />);

    expect(container.querySelector('.sd-message-response')).not.toBeNull();
  });

  it('keeps a newline-wrapped answer, which does have printable content', () => {
    const parts: ChatMessagePart[] = [
      { type: 'text', text: '\nDone.\n', state: 'done' } as ChatMessagePart,
    ];

    const { container } = render(<MessagePartList parts={parts} />);

    expect(container.querySelector('.sd-message-response')).not.toBeNull();
  });
});

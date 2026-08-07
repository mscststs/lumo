// @vitest-environment jsdom
/**
 * A tool call left unfinished by an interrupted turn.
 *
 * A tool part is persisted exactly as it stood, so a turn cut short while an MCP
 * tool was running keeps `input-available` on disk forever — and that state
 * renders as a spinner. Reopening the conversation therefore showed the call
 * still "running", with no request behind it and nothing that would ever settle
 * it. Nothing in the display knew the turn had ended.
 *
 * These pin the derivation that fixes it: an unsettled call is pending only
 * while the turn producing it is live.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ChatMessage, ChatMessagePart } from '@/types';

// Labels are asserted through their i18n keys, so the test does not restate the
// copy and stays valid when the wording changes.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { toolDisplayState } = await import('@/components/ai-elements/tool');
const { MessagePartList } = await import('@/components/chat/MessagePartList');
const { MessageBubble } = await import('@/components/chat/MessageBubble');

/** A tool part in `state`, shaped like the SDK's `dynamic-tool` part. */
function toolPart(state: string): ChatMessagePart {
  return {
    type: 'dynamic-tool',
    toolName: 'page_screenshot',
    toolCallId: 'call-1',
    state,
    input: { fullPage: true },
    ...(state === 'output-available' ? { output: { content: [], isError: false } } : {}),
    ...(state === 'output-error' ? { errorText: 'boom' } : {}),
  } as unknown as ChatMessagePart;
}

describe('toolDisplayState', () => {
  it.each(['input-streaming', 'input-available'])(
    'reports %s as interrupted once the turn is no longer streaming',
    (state) => {
      // The regression: these two are the only states a turn can be *left* in,
      // and both spin.
      expect(toolDisplayState(state as never, false)).toBe('interrupted');
    },
  );

  it.each(['input-streaming', 'input-available'])(
    'leaves %s alone while the turn is still streaming',
    (state) => {
      expect(toolDisplayState(state as never, true)).toBe(state);
    },
  );

  it.each(['output-available', 'output-error', 'output-denied', 'approval-requested'])(
    'never rewrites %s, which the turn actually reached',
    (state) => {
      expect(toolDisplayState(state as never, false)).toBe(state);
    },
  );
});

describe('a tool call rendered after its turn ended', () => {
  it('stops spinning and reports itself interrupted', () => {
    const { container } = render(
      <MessagePartList parts={[toolPart('input-available')]} isStreaming={false} />,
    );

    // The spinner is the whole complaint: it promises work still in progress.
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.textContent).toContain('sidebar.tool.interrupted');
    expect(container.textContent).not.toContain('sidebar.tool.running');
  });

  it('keeps spinning while the turn is still live', () => {
    const { container } = render(
      <MessagePartList parts={[toolPart('input-available')]} isStreaming />,
    );

    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain('sidebar.tool.running');
  });

  it('still shows a completed call as completed', () => {
    const { container } = render(
      <MessagePartList parts={[toolPart('output-available')]} isStreaming={false} />,
    );

    expect(container.textContent).toContain('sidebar.tool.completed');
    expect(container.textContent).not.toContain('sidebar.tool.interrupted');
  });

  it('settles the call when a reopened conversation renders the stored turn', () => {
    // The end-to-end shape of the bug: a persisted interrupted message, rendered
    // the way `ChatMessageList` renders a message that is not the live one.
    const message: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [toolPart('input-available')],
      interrupted: true,
      timestamp: 1,
    };

    const { container } = render(<MessageBubble message={message} isStreaming={false} />);

    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.textContent).toContain('sidebar.tool.interrupted');
  });
});

describe('the interrupted-reply notice', () => {
  const message: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'half an answ', state: 'done' }] as ChatMessagePart[],
    interrupted: true,
    timestamp: 1,
  };

  it('is separated from the reply above it', () => {
    const { container } = render(<MessageBubble message={message} isStreaming={false} />);

    const notice = [...container.querySelectorAll('div')].find((el) =>
      el.textContent === 'sidebar.interrupted',
    );
    expect(notice, 'the notice should be rendered').toBeDefined();
    // The assistant `Message` is a gapless flex column — only the user variant
    // sets a gap — so a child with no padding sits flush against the last line
    // of prose and reads as part of the answer. `MessageActions` solves this the
    // same way, with `pt-1`.
    expect(notice!.className).toMatch(/\bpt-/);
  });

  it('is not shown while the turn is still streaming', () => {
    // Unfinished is the expected state mid-stream, not something to flag.
    const { container } = render(<MessageBubble message={message} isStreaming />);
    expect(container.textContent).not.toContain('sidebar.interrupted');
  });
});

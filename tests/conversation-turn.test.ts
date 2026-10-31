import { describe, it, expect } from 'vitest';
import { appendAssistantTurn } from '@/lib/conversation-turn';
import type { ChatMessagePart, Conversation, TokenUsageStats } from '@/types';

/**
 * The same builder produces a mid-stream checkpoint and the settled reply; only
 * the flags differ. Getting a flag wrong is what made an interrupted reply look
 * complete (or a complete one look truncated), so each one is pinned here.
 */

const USER_MESSAGE = {
  id: 'u1',
  role: 'user' as const,
  parts: [{ type: 'text', text: 'hi', state: 'done' }] as ChatMessagePart[],
  timestamp: 1,
};

function conversation(): Conversation {
  return {
    id: 'c1',
    title: 't',
    messages: [USER_MESSAGE],
    modelId: 'm',
    providerId: 'p',
    createdAt: 0,
    updatedAt: 0,
  };
}

const TURN = { id: 'a1', timestamp: 2 };
const PARTS: ChatMessagePart[] = [{ type: 'text', text: 'answer', state: 'done' }];
const USAGE: TokenUsageStats = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };

describe('appendAssistantTurn', () => {
  it('returns null when the turn produced nothing renderable', () => {
    expect(appendAssistantTurn(conversation(), TURN, [], { interrupted: false })).toBeNull();
    expect(
      appendAssistantTurn(
        conversation(),
        TURN,
        [{ type: 'text', text: '', state: 'streaming' }],
        { interrupted: false },
      ),
    ).toBeNull();
  });

  it('appends the turn under the identity the bubble already rendered', () => {
    const result = appendAssistantTurn(conversation(), TURN, PARTS, { interrupted: false })!;
    const saved = result.messages.at(-1)!;

    expect(saved.id).toBe('a1');
    expect(saved.timestamp).toBe(2);
    expect(saved.role).toBe('assistant');
    expect(saved.parts).toBe(PARTS);
    expect(result.messages).toHaveLength(2);
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it('marks a checkpoint as interrupted without a stop reason', () => {
    const saved = appendAssistantTurn(conversation(), TURN, PARTS, { interrupted: true })!
      .messages.at(-1)!;
    expect(saved.interrupted).toBe(true);
    expect(saved.stopReason).toBeUndefined();
  });

  it('carries the step-cap reason and usage through', () => {
    const saved = appendAssistantTurn(conversation(), TURN, PARTS, {
      interrupted: true,
      stopReason: 'step-limit',
      usage: USAGE,
    })!.messages.at(-1)!;
    expect(saved.stopReason).toBe('step-limit');
    expect(saved.usage).toBe(USAGE);
  });

  it('attaches regeneration variants', () => {
    const variants = [{ id: 'v0', parts: PARTS, timestamp: 2 }];
    const saved = appendAssistantTurn(conversation(), TURN, PARTS, {
      interrupted: false,
      variants,
    })!.messages.at(-1)!;
    expect(saved.variants).toBe(variants);
  });

  it('never mutates the conversation it was given', () => {
    const original = conversation();
    const result = appendAssistantTurn(original, TURN, PARTS, { interrupted: false })!;
    expect(original.messages).toHaveLength(1);
    expect(result).not.toBe(original);
    expect(result.messages).not.toBe(original.messages);
  });
});

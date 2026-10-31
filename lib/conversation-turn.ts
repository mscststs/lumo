/**
 * Assistant-turn snapshots.
 *
 * A streaming turn is written to disk in two shapes — a mid-stream checkpoint
 * (`interrupted: true`) and the settled reply — and both are "the same message
 * with different flags". Keeping that construction here makes the flag rules
 * testable without a hook, and keeps the streaming orchestrator focused on
 * lifecycle rather than message shape.
 */

import { hasRenderableParts } from '@/lib/message-parts';
import type {
  ChatMessage,
  ChatMessagePart,
  ChatMessageVariant,
  Conversation,
  TokenUsageStats,
} from '@/types';

/**
 * Identity of one assistant turn, allocated before the first chunk arrives so
 * the streaming bubble and the persisted message agree on both fields.
 */
export interface AssistantTurn {
  /** The id the finished message will be saved under. */
  id: string;
  /** When the turn started — kept across retries so it reflects the user's ask. */
  timestamp: number;
}

export interface AssistantTurnOptions {
  /**
   * A checkpoint is always interrupted; a settled turn is complete unless the
   * user, a teardown or the step cap cut it short.
   */
  interrupted: boolean;
  /** Set when the configured step cap, rather than the model, ended the turn. */
  stopReason?: 'step-limit';
  usage?: TokenUsageStats;
  /** Regeneration variants collected for this turn, when any. */
  variants?: ChatMessageVariant[];
}

/**
 * Append the in-flight assistant turn to `conversation`, or return `null` when
 * it produced nothing worth storing.
 *
 * Never mutates the input: callers hold the previous conversation while a save
 * is in flight, and a mid-stream checkpoint must not leak into it.
 */
export function appendAssistantTurn(
  conversation: Conversation,
  turn: AssistantTurn,
  parts: ChatMessagePart[],
  options: AssistantTurnOptions,
): Conversation | null {
  if (!hasRenderableParts(parts)) return null;

  const message: ChatMessage = {
    ...turn,
    role: 'assistant',
    parts,
    ...(options.interrupted ? { interrupted: true } : {}),
    ...(options.stopReason ? { stopReason: options.stopReason } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.variants ? { variants: options.variants } : {}),
  };

  return {
    ...conversation,
    messages: [...conversation.messages, message],
    updatedAt: Date.now(),
  };
}

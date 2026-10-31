import { describe, it, expect, vi, afterEach } from 'vitest';
import { TurnPersistence } from '@/store/turn/persistence';
import type { ChatMessagePart, Conversation, TokenUsageStats } from '@/types';

const TURN = { id: 'a1', timestamp: 2 };
const PARTS: ChatMessagePart[] = [{ type: 'text', text: 'answer', state: 'done' }];
const USAGE: TokenUsageStats = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };

function conversation(): Conversation {
  return {
    id: 'c1',
    title: 't',
    messages: [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi', state: 'done' }],
        timestamp: 1,
      },
    ],
    modelId: 'm',
    providerId: 'p',
    createdAt: 0,
    updatedAt: 0,
  };
}

function createPersistence() {
  const save = vi.fn<(conversation: Conversation, options?: { create?: boolean }) => Promise<void>>(
    async () => {},
  );
  const saveDraft = vi.fn<(conversation: Conversation) => Promise<void>>(async () => {});
  const open = vi.fn<(conversation: Conversation) => Promise<void>>(async () => {});
  const onSaveError = vi.fn<(error: Error) => void>();
  const persistence = new TurnPersistence({
    conversation: conversation(),
    turn: TURN,
    canCreate: true,
    ports: { save, saveDraft, open, onSaveError },
  });
  return { persistence, save, saveDraft, open, onSaveError };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TurnPersistence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds the turn under the identity the bubble rendered', () => {
    const { persistence } = createPersistence();
    const snapshot = persistence.snapshot(PARTS, { interrupted: false })!;
    const saved = snapshot.messages.at(-1)!;
    expect(saved.id).toBe('a1');
    expect(saved.timestamp).toBe(2);
    expect(saved.interrupted).toBeUndefined();
    expect(snapshot.messages).toHaveLength(2);
  });

  it('returns null when the turn produced nothing renderable', () => {
    const { persistence } = createPersistence();
    expect(persistence.snapshot([], { interrupted: true })).toBeNull();
  });

  it('can snapshot onto a different conversation version', () => {
    const { persistence } = createPersistence();
    const compacted = { ...conversation(), id: 'c2', title: 'compacted' };
    const snapshot = persistence.snapshot(PARTS, { interrupted: true }, compacted)!;
    expect(snapshot.id).toBe('c2');
    expect(snapshot.title).toBe('compacted');
  });

  it('writes a forced checkpoint and keeps the latest parts', async () => {
    const { persistence, saveDraft } = createPersistence();
    persistence.setParts(PARTS);
    await persistence.checkpoint(PARTS);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0]![0]).toMatchObject({ id: 'c1' });
    expect(persistence.latestParts).toBe(PARTS);
  });

  it('throttles stream checkpoints but writes again after the interval', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { persistence, saveDraft } = createPersistence();

    persistence.checkpointThrottled(PARTS);
    await tick();
    expect(saveDraft).toHaveBeenCalledTimes(1);

    persistence.checkpointThrottled(PARTS);
    await tick();
    expect(saveDraft).toHaveBeenCalledTimes(1);

    now += 1001;
    persistence.checkpointThrottled(PARTS);
    await tick();
    expect(saveDraft).toHaveBeenCalledTimes(2);
  });

  it('flushes the latest partial turn, and nothing when empty', async () => {
    const { persistence, saveDraft } = createPersistence();
    await persistence.flush();
    expect(saveDraft).not.toHaveBeenCalled();

    persistence.setParts(PARTS);
    await persistence.flush();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const snapshot = saveDraft.mock.calls[0]![0] as Conversation;
    expect(snapshot.messages.at(-1)!.interrupted).toBe(true);
  });

  it('passes canCreate through to the final save and reports failures', async () => {
    const { persistence, save, onSaveError } = createPersistence();
    const settled = persistence.snapshot(PARTS, {
      interrupted: false,
      usage: USAGE,
    })!;
    await persistence.saveSettled(settled);
    expect(save).toHaveBeenCalledWith(settled, { create: true });

    save.mockRejectedValueOnce(new Error('quota'));
    await persistence.saveSettled(settled);
    expect(onSaveError).toHaveBeenCalledTimes(1);
  });
});

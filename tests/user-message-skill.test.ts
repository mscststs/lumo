/**
 * A `/skill:` message must reach the model as *instructions attachment + request
 * text*, in that order.
 *
 * The composer decides that shape in `ChatInput`, but the wire form is built by
 * `buildUserParts` — so the promise "the skill is an attachment, not a wall of
 * prompt text" is only kept if this ordering survives the trip through the
 * conversation store. The failure this guards against is silent: gluing the
 * block back onto the prompt would still send the right words, just as the one
 * attachment the transcript no longer shows.
 */
import { describe, expect, it } from 'vitest';
import { buildUserMessage, buildUserParts } from '@/lib/user-message';
import type { QueuedUserInput, TextAttachment } from '@/types';

const SKILL_BLOCK = '<skill name="pdf-tools" location="skills/pdf-tools/SKILL.md">\nBody\n</skill>';

const skillAttachment: TextAttachment = {
  id: 'a1',
  kind: 'skill',
  mediaType: 'text/plain',
  content: SKILL_BLOCK,
  modelText: SKILL_BLOCK,
  preview: 'pdf-tools',
};

function content(overrides: Partial<QueuedUserInput> = {}): QueuedUserInput {
  return {
    id: 'm1',
    text: 'extract a.pdf',
    images: [],
    textAttachments: [skillAttachment],
    timestamp: 1,
    ...overrides,
  };
}

describe('buildUserParts with a skill attachment', () => {
  it('writes the instructions before the prompt', () => {
    const parts = buildUserParts(content());
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text', text: `${SKILL_BLOCK}\n-----\n` });
    expect(parts[1]).toMatchObject({ type: 'text', text: 'extract a.pdf' });
  });

  it('sends a skill-only draft as one attachment part', () => {
    const parts = buildUserParts(content({ text: '' }));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text', text: `${SKILL_BLOCK}\n-----\n` });
  });

  it('keeps the attachment metadata, so the transcript can render its card', () => {
    const message = buildUserMessage(content());
    expect(message.textAttachments).toEqual([skillAttachment]);
  });
});

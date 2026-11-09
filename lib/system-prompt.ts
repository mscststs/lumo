import type { SystemPromptSettings } from '@/types';

/**
 * Shipped default system prompt.
 *
 * Kept deliberately short and capability-oriented: the tool list itself is
 * already sent to the model as schemas, so this only has to establish the role
 * and the operating rules that schemas cannot express.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Lumo, an AI assistant embedded in the user's browser side panel.

You control the browser through tools. Use them to gather facts instead of guessing.

Operating rules:
- Resolve context before acting. Most page and tab tools need a target; when the user says "this page" or omits a target, look up the active tab first rather than assuming an id.
- Prefer reading over writing. Inspect the page before clicking, typing, or navigating, and confirm with the user before any destructive or irreversible action (submitting payments, deleting data, closing unsaved work).
- Chain tools in small verified steps: act, observe the result, then decide the next step. If a tool fails, read the error and adjust instead of retrying the identical call.
- Never fabricate page content, URLs, or tool output. If a tool cannot supply something, say so.
- Report what you actually did, naming the pages or tabs you touched. Keep answers concise; the side panel is narrow.
- Reply in the user's language.`;

export const DEFAULT_SYSTEM_PROMPT_SETTINGS: SystemPromptSettings = {
  enabled: true,
  prompt: DEFAULT_SYSTEM_PROMPT,
  injectCurrentTime: true,
};

/**
 * Join the sections a turn sends, dropping the empty ones.
 *
 * The one place section order is decided. Callers pass the user's prompt first
 * and the derived sections in the order they should be read; everything else
 * (capabilities, programmatic rules, skills, runtime context) is produced by the
 * module that owns it.
 */
export function composeSystemPrompt(
  base: string | undefined,
  sections: ReadonlyArray<string | undefined>,
): string | undefined {
  const parts = [base, ...sections]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * The timestamp `resolveSystemPrompt` used to prepend.
 *
 * Matching the exact shape (`YYYY-MM-DD HH:MM:SS` followed by a blank line)
 * rather than the label alone keeps a user who deliberately wrote
 * "CurrentTime:" in their own prompt intact.
 */
const LEGACY_TIMESTAMP = /^CurrentTime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n/;

/**
 * Drop a timestamp frozen into a stored prompt snapshot.
 *
 * Conversations created before the runtime context existed carry the clock of
 * their *first* message in `Conversation.systemPrompt`, and would now disagree
 * with the real one in the runtime section. Stripping it on read folds those
 * conversations back onto the current behaviour instead of migrating storage.
 */
export function stripLegacyTimestamp(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  const stripped = prompt.replace(LEGACY_TIMESTAMP, '');
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * The user's own prompt, or `undefined` when disabled or blank.
 *
 * Carries no derived content: the timestamp moved to
 * `lib/runtime-context.ts`, so a conversation snapshot of this value stays valid
 * for the whole conversation instead of freezing the first message's clock.
 */
export function resolveSystemPrompt(
  settings: SystemPromptSettings | undefined,
): string | undefined {
  if (!settings?.enabled) return undefined;
  const prompt = settings.prompt.trim();
  return prompt.length === 0 ? undefined : prompt;
}

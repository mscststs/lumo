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
};

/** The prompt to actually send, or `undefined` when disabled or blank. */
export function resolveSystemPrompt(
  settings: SystemPromptSettings | undefined,
): string | undefined {
  if (!settings?.enabled) return undefined;
  const prompt = settings.prompt.trim();
  if (prompt.length === 0) return undefined;

  if (settings.injectCurrentTime) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return `CurrentTime: ${timestamp}\n\n${prompt}`;
  }

  return prompt;
}

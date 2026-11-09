/**
 * Per-turn system prompt assembly.
 *
 * The user's prompt is *stable*: it is written once, snapshotted into the
 * conversation, and replayed for the rest of that conversation. Everything else
 * in the system prompt is derived fresh for every request — the capability map
 * (servers connect and disconnect), the programmatic rules (the mode can be
 * toggled), the skills index (a skill can be installed in another tab), and the
 * runtime context (the clock and the active tab).
 *
 * Keeping that split in one function is what lets the runner stay an orchestrator
 * instead of a string builder, and it gives the tests a single seam: mocking
 * `buildTurnSystemPrompt` removes the whole prompt from a streaming test without
 * having to fake storage, the registry and `chrome.tabs`.
 *
 * Section order is the reading order — who you are → what the browser can do →
 * how to drive it → which skills exist → what changed since the last request.
 * The runtime section is last because it is the only one that differs between two
 * otherwise identical requests, which leaves the widest stable prefix for a
 * provider's prefix cache.
 */

import { composeSystemPrompt } from '@/lib/system-prompt';
import { formatCapabilityIndex } from '@/lib/mcp/capability-index';
import { PROGRAMMATIC_TOOLS_PROMPT } from '@/lib/shell/prompt';
import { skillsPromptSection } from '@/lib/skills';
import {
  formatRuntimeContext,
  readActiveTab,
  type ActiveTabInfo,
} from '@/lib/runtime-context';

export interface TurnPromptInput {
  /** The user's prompt, or the conversation's snapshot of it. */
  base?: string;
  /** Whether the shell tool set replaced the flat MCP tool list. */
  programmatic: boolean;
  /** Whether to report the clock in the runtime section. */
  injectCurrentTime: boolean;
  /** Clock override, for tests and for callers that already read the time. */
  now?: Date;
  /** Tab reader override. Defaults to the active tab of the focused window. */
  readTab?: () => Promise<ActiveTabInfo | undefined>;
}

export async function buildTurnSystemPrompt(
  input: TurnPromptInput,
): Promise<string | undefined> {
  const [skills, tab] = await Promise.all([
    skillsPromptSection(),
    (input.readTab ?? readActiveTab)(),
  ]);

  const runtime = formatRuntimeContext({
    ...(input.injectCurrentTime ? { now: input.now ?? new Date() } : {}),
    ...(tab ? { tab } : {}),
  });

  return composeSystemPrompt(input.base, [
    input.programmatic ? formatCapabilityIndex() : undefined,
    input.programmatic ? PROGRAMMATIC_TOOLS_PROMPT : undefined,
    skills,
    runtime,
  ]);
}

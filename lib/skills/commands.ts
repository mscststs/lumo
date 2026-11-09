/**
 * `/skill:<name>` — the explicit path to a skill.
 *
 * The prompt index is a routing hint, not a guarantee: a model can read a task
 * and simply not load the skill that describes it. Pi solves this with an
 * explicit command, and so does Lumo: `/skill:pdf-tools extract a.pdf` loads the
 * skill's instructions, exactly as if the model had loaded it perfectly.
 *
 * ## Why the instructions travel as an attachment
 *
 * The instructions are a payload, not something the user typed. Sending them as
 * prompt text made the composer lie about what was being sent: the transcript
 * showed one long wall of instructions, the request was buried at its end, and
 * the block could not be removed or moved once it was written.
 *
 * So the composer builds a `kind: 'skill'` {@link TextAttachment} instead: the
 * instructions become a chip beside the draft, the user's own request stays in
 * the composer as ordinary text, and the message is built by `buildUserParts`
 * with the attachment ahead of the prompt — the order the model should read
 * them in. Everything attachments already do then applies for free: the chip is
 * removable, draggable between panels, queued mid-turn, and rendered as a card
 * in the transcript.
 *
 * The build still happens in the composer, before the message is sent, so it is
 * a user-visible act rather than something the model has to be trusted with. It
 * also means a skill works in a conversation that already started, with no
 * system-prompt change of any kind.
 */
import { v4 as uuidv4 } from 'uuid';
import { commandKey, COMMAND_PREFIX, type ResolvedCommand } from '@/lib/slash-commands';
import { fileStorage, parentDirPath } from '@/lib/mcp/file-storage';
import { parseFrontmatter } from './frontmatter';
import type { Skill } from './validate';
import type { TextAttachment } from '@/types';

/** Reserved trigger prefix, so a skill never collides with a user phrase. */
export const SKILL_COMMAND_PREFIX = 'skill:';

/** The trigger a skill is invoked by, without the leading `/`. */
export function skillCommandName(name: string): string {
  return `${SKILL_COMMAND_PREFIX}${name}`;
}

/** Turn an indexed skill into a composer command. */
export function skillToCommand(skill: Skill): ResolvedCommand {
  return {
    kind: 'skill',
    id: skill.name,
    name: skillCommandName(skill.name),
    path: skill.path,
    description: skill.description,
  };
}

/**
 * Append skill commands after the user's own.
 *
 * `disable-model-invocation` skills are included: that flag hides a skill from
 * the prompt index, which is precisely the case where the command is the only
 * way to reach it. Skills lose a name collision against a real user command;
 * nothing is renamed behind the user's back.
 */
export function withSkillCommands(
  commands: ResolvedCommand[],
  skills: Skill[],
): ResolvedCommand[] {
  const seen = new Set(commands.map((command) => commandKey(command.name)));
  const resolved = [...commands];
  for (const skill of skills) {
    const command = skillToCommand(skill);
    const key = commandKey(command.name);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(command);
  }
  return resolved;
}

export interface SkillExpansion {
  name: string;
  /** Storage path of `SKILL.md`. */
  path: string;
  /** Storage directory of the skill, with a trailing slash. */
  dir: string;
  /** Skill instructions (frontmatter stripped). */
  body: string;
}

/**
 * Render the instruction block for a skill.
 *
 * Same shape as Pi's expansion: the instructions wrapped in a `<skill>` block
 * that names the file and its directory (so relative paths resolve). The
 * wrapper is what lets the model tell instructions apart from the request that
 * follows them as ordinary prompt text.
 */
export function expandSkillInstructions(expansion: SkillExpansion): string {
  const body = expansion.body.trim();
  return [
    `<skill name="${expansion.name}" location="${expansion.path}">`,
    `References are relative to ${expansion.dir}. Read a referenced file with file_read before using it.`,
    '',
    body,
    '</skill>',
  ].join('\n');
}

/**
 * Read a skill's instructions as the attachment its command sends.
 *
 * `content` and `modelText` are the same string on purpose: the transcript card
 * shows exactly what the model reads, and no marker is prefixed to it because a
 * `<skill>` block already names itself.
 *
 * A missing file returns `null` rather than an empty attachment — the caller
 * falls back to sending the text the user typed, so a skill deleted under the
 * draft degrades to an ordinary message instead of an error that eats it.
 */
export async function loadSkillAttachment(
  command: Extract<ResolvedCommand, { kind: 'skill' }>,
): Promise<TextAttachment | null> {
  const raw = await fileStorage.readFileAsText(command.path).catch(() => null);
  if (raw === null) return null;

  const parsed = parseFrontmatter(raw);
  const content = expandSkillInstructions({
    name: command.id,
    path: command.path,
    dir: parentDirPath(command.path),
    body: parsed.ok ? parsed.document.body : raw,
  });

  return {
    id: uuidv4(),
    kind: 'skill',
    mediaType: 'text/plain',
    content,
    // Verbatim: the block is already self-describing, and the model should read
    // the instructions exactly as the card shows them.
    modelText: content,
    preview: command.id,
  };
}

/** The text a skill command falls back to when its file has vanished. */
export function skillCommandFallback(
  command: Extract<ResolvedCommand, { kind: 'skill' }>,
  args: string,
): string {
  return [COMMAND_PREFIX + command.name, args].filter(Boolean).join(' ');
}


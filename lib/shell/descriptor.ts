/**
 * The `sh` tool's declaration, kept free of the runtime.
 *
 * History conversion, the model prompt and the UI all need to name the tool and
 * describe its input, but only execution needs just-bash and QuickJS. Splitting
 * the declaration out means a turn that happens to contain an old `sh` call can
 * be converted back into a model prompt without loading the interpreter, and a
 * single constant names the tool everywhere instead of five literal `'sh'`s.
 */

import { z } from 'zod';
import { mcpToModelOutput } from '@/lib/mcp/registry';

/** The one tool that executes scripts. Referenced by UI, prompt and fingerprint. */
export const SHELL_TOOL_NAME = 'sh';

/** Per-call scope: which conversation owns files the script writes. */
export interface ShellToolContext {
  conversationId?: string;
}

/**
 * The file tools the model keeps in programmatic mode.
 *
 * Everything else the flat list used to expose is reachable from `sh` instead.
 */
export const PROGRAMMATIC_FILE_TOOLS = ['file_read', 'file_write', 'file_edit'] as const;

export const SHELL_INPUT_SCHEMA = z.object({
  command: z.string().describe('Bash script to execute'),
  cwd: z.string().optional().describe('Working directory (default: /)'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Wall-clock limit in milliseconds. Omit for no limit.'),
});

/**
 * The `sh` description: syntax and environment limits, in that order.
 *
 * It stops there on purpose. Strategy (pipeline before program) lives in the
 * programmatic-mode system prompt, and the capability map lives in
 * `lib/mcp/capability-index.ts`; duplicating either here only spends tokens
 * twice and pushes the model toward whichever copy is longest.
 */
export const SHELL_TOOL_DESCRIPTION = [
  'Execute a bash script. The filesystem is shared with file_read/file_write/file_edit',
  '(`/notes.md` and `notes.md` are the same file).',
  '',
  'MCP tools are shell commands:',
  '  mcp list',
  '  mcp find <keyword>',
  '  mcp tools <server>',
  '  mcp describe <server>.<tool>',
  "  mcp call <server>.<tool> '<json>' [--output <path>] [--raw] [--json]",
  '',
  'Pipes, redirections, variables, loops, globs and the usual tools work: rg, grep,',
  'sed, awk, jq, sort, uniq, cut, xargs, curl, tar, zip/unzip, yq, iconv.',
  '`node -e` runs JavaScript for what a pipeline cannot express.',
  '',
  'Not available in a browser extension: sockets (http/net/dns), processes, python3,',
  'sqlite3, symlinks. JavaScript has both `await fs.readFile(...)` and `fs.readFileSync(...)`.',
  '',
  'Output past 2000 lines / 50 KB is truncated and the full text is written to tmp/.',
  'MCP images land in tmp/ and can be read with file_read.',
].join('\n');

/**
 * A definition usable for `convertToModelMessages` without an executor.
 *
 * `toModelOutput` is the only field the AI SDK consults when replaying stored
 * tool results, so this is what lets a transcript written in one mode stay
 * readable in the other.
 */
export const shellToolDescriptor = {
  name: SHELL_TOOL_NAME,
  description: SHELL_TOOL_DESCRIPTION,
  inputSchema: SHELL_INPUT_SCHEMA,
  toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) =>
    mcpToModelOutput(options),
} as const;

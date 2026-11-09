/**
 * System-prompt addendum for programmatic mode.
 *
 * Two rules shape this section:
 *
 *  - It carries *strategy*, never syntax. The `sh` tool description sits next to
 *    the schema and already lists the `mcp` subcommands; repeating them here cost
 *    ~250 characters of duplicated prompt for no behavioural gain.
 *  - It states the pipeline-first preference explicitly. The previous version
 *    spent eight lines enumerating what `node` can do and none recommending a
 *    pipeline, and the model did what the largest paragraph described: it wrote
 *    JavaScript to do what `jq` and `grep` already do inside the interpreter.
 *
 * The capability index (`lib/mcp/capability-index.ts`) is injected before this
 * section and is what removes the `mcp list` → `mcp tools` → `mcp describe`
 * warm-up.
 */

import { PROGRAMMATIC_FILE_TOOLS, SHELL_TOOL_NAME } from './descriptor';

const TOOL_LIST = [...PROGRAMMATIC_FILE_TOOLS, SHELL_TOOL_NAME].join(', ');

export const PROGRAMMATIC_TOOLS_PROMPT = `## Programmatic mode

You have four tools: ${TOOL_LIST}. All four share one filesystem (\`/notes.md\` and the file path \`notes.md\` are the same file), and \`/skills\` is a writable directory like any other.

Reach for one pipeline before writing a program. ls, rg, grep, sed, awk, jq, sort, uniq, head, tail, wc, find, xargs, curl, tar and yq are all available, and a pipeline keeps the answer inside the result you read instead of asking you to relay it.

Node is the fallback, not the default: \`node -e '<js>'\` runs JavaScript in a QuickJS sandbox with top-level await, timers, \`fetch\`, \`require\` of builtins, \`await exec('…')\` and \`await tools['<server>']['<tool>'](params)\`. Choose it when the task needs what a pipeline cannot express — loops over many items, concurrency, retries, or JSON reshaping that jq makes clumsy.

Keep intermediate output out of the transcript: write large results to tmp/ and inspect them with grep/head/tail rather than printing everything.`;

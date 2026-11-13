/**
 * Command shims layered on top of just-bash through its public extension point.
 *
 * Each entry is a `defineCommand` shadow of a bundled command: it fixes one
 * argument-level gap (a missing flag, a wrong default, a lost header) and
 * forwards everything else to the original through `ctx.origCommand`. Nothing
 * here re-implements a command's core behaviour, so an upstream release that
 * adds the same flag is a one-file delete rather than a merge conflict.
 *
 * `uname` and `ps` are new commands rather than shadows; they exist because the
 * bundled set has no platform probe at all.
 */

import type { Command } from 'just-bash/browser';
import { createCurlCommand } from './curl';
import { createDateCommand } from './date';
import { createJqCommand } from './jq';
import { createPsCommand } from './ps';
import { createStatCommand } from './stat';
import { createTouchCommand } from './touch';
import { createUnameCommand } from './uname';
import { createWhichCommand } from './which';

/**
 * Every shim, in one list for the runtime to register.
 *
 * Order does not matter: just-bash keys custom commands by name, and none of
 * these share a name with each other.
 */
export function createCompatCommands(): Command[] {
  return [
    createJqCommand(),
    createStatCommand(),
    createDateCommand(),
    createWhichCommand(),
    createTouchCommand(),
    createCurlCommand(),
    createUnameCommand(),
    createPsCommand(),
  ];
}

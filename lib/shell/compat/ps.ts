/**
 * `ps` — a single-process table.
 *
 * A script that starts with `ps aux | grep -q …` (health checks, "is anything
 * already running") died on `command not found`. The sandbox runs one script at
 * a time and has no process table, so the honest answer is one row describing
 * the shell itself; `pgrep`-style bookkeeping is out of scope.
 */

import { defineCommand } from 'just-bash/browser';

const PID = 1;
const USER = 'user';

function defaultTable(): string {
  return ['    PID TTY          TIME CMD', `${String(PID).padStart(7)} ?        00:00:00 bash`, ''].join('\n');
}

function auxTable(): string {
  return [
    'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
    `${USER.padEnd(8)} ${String(PID).padStart(7)}  0.0  0.0   1024   512 ?        Ss   00:00   0:00 bash`,
    '',
  ].join('\n');
}

export function createPsCommand() {
  return defineCommand('ps', async (args) => {
    // `ps aux`, `-ef`, `-A`, `-e`, `x` … all describe the same single process
    // here; match the two output shapes scripts parse instead of rejecting flags.
    const wantsAux = args.some((arg) => /^(aux|-aux|-ef|-eF)$/.test(arg)) || args.includes('u');
    return {
      stdout: wantsAux ? auxTable() : defaultTable(),
      stderr: '',
      exitCode: 0,
    };
  });
}

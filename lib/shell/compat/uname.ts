/**
 * `uname` — the platform probe scripts run before anything else.
 *
 * just-bash implements `whoami` and `hostname` but not `uname`, so the very
 * first line of a portable script (`case "$(uname -s)" in …`) failed with
 * `command not found`. The answers come from `system-facts.ts`, the same module
 * `/proc/version` is built from, so the two can never disagree.
 */

import { defineCommand, type ExecResult } from 'just-bash/browser';
import { KERNEL_VERSION, MACHINE, NODENAME, OPERATING_SYSTEM, RELEASE, SYSNAME } from '../system-facts';

interface Field {
  char: string;
  long: string;
  value: string;
}

const FIELDS: Field[] = [
  { char: 's', long: 'kernel-name', value: SYSNAME },
  { char: 'n', long: 'nodename', value: NODENAME },
  { char: 'r', long: 'kernel-release', value: RELEASE },
  { char: 'v', long: 'kernel-version', value: KERNEL_VERSION },
  { char: 'm', long: 'machine', value: MACHINE },
  // There is no separate processor/hardware platform on a single-architecture
  // sandbox; repeat the machine the way `uname -a` does on a real kernel.
  { char: 'p', long: 'processor', value: MACHINE },
  { char: 'i', long: 'hardware-platform', value: MACHINE },
  { char: 'o', long: 'operating-system', value: OPERATING_SYSTEM },
];

const HELP = [
  'Usage: uname [OPTION]...',
  'Print certain system information.',
  '',
  ...FIELDS.map((field) => `  -${field.char}, --${field.long.padEnd(18)} print the ${field.long.replace(/-/g, ' ')}`),
  '  -a, --all                print all information',
].join('\n');

function usageError(message: string): ExecResult {
  return { stdout: '', stderr: `uname: ${message}\nTry 'uname --help' for more information.\n`, exitCode: 1 };
}

interface Parsed {
  flags: string[];
  help: boolean;
  error?: ExecResult;
}

function parse(args: string[]): Parsed {
  const flags: string[] = [];
  let help = false;

  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--help') {
      help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      if (arg === '--all') {
        flags.push('a');
        continue;
      }
      const field = FIELDS.find((candidate) => candidate.long === arg.slice(2));
      if (!field) return { flags, help, error: usageError(`unrecognized option '${arg}'`) };
      flags.push(field.char);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const char of arg.slice(1)) {
        if (char !== 'a' && !FIELDS.some((field) => field.char === char)) {
          return { flags, help, error: usageError(`invalid option -- '${char}'`) };
        }
        flags.push(char);
      }
      continue;
    }
    return { flags, help, error: usageError(`extra operand '${arg}'`) };
  }

  return { flags, help };
}

/** `-a` prints every field in order; otherwise only the requested ones. */
function render(flags: string[]): string {
  if (flags.length === 0) return SYSNAME;
  if (flags.includes('a')) return FIELDS.map((field) => field.value).join(' ');
  const order = FIELDS.filter((field) => flags.includes(field.char));
  return order.map((field) => field.value).join(' ');
}

export function createUnameCommand() {
  return defineCommand('uname', async (args) => {
    const parsed = parse(args);
    if (parsed.error) return parsed.error;
    if (parsed.help) return { stdout: `${HELP}\n`, stderr: '', exitCode: 0 };
    return { stdout: `${render(parsed.flags)}\n`, stderr: '', exitCode: 0 };
  });
}

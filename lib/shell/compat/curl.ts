/**
 * `curl` — surface the one thing the browser takes away.
 *
 * A script can pass `-A curl/8` and curl will set the header, but the browser
 * drops `User-Agent` (and every other `Sec-*`/`Origin` header) before the request
 * leaves the extension. Servers that key on the user agent — wttr.in among them —
 * therefore answer with the HTML page they show browsers, and the script spends a
 * round discovering that the flag "did nothing".
 *
 * The request is left exactly as it was; only a diagnostic is added. Removing the
 * header is impossible from inside the runtime, so making the constraint visible
 * is the honest fix.
 */

import { defineCommand } from 'just-bash/browser';

const WARNING =
  'curl: warning: -A/--user-agent is ignored (the browser owns that header); ' +
  'if the endpoint answers with HTML, pipe it through html-to-markdown\n';

function setsUserAgent(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '-A' || arg === '--user-agent') return true;
    if (arg.startsWith('--user-agent=')) return true;
    // Bundled short flags: `-sA value`, `-Acurl/8`.
    if (!arg.startsWith('--') && /^-[a-zA-Z]*A/.test(arg)) return true;
  }
  return false;
}

export function createCurlCommand() {
  return defineCommand('curl', async (args, ctx) => {
    const original = ctx.origCommand;
    if (!original) return { stdout: '', stderr: 'curl: command is not available\n', exitCode: 127 };

    const result = await original(args);
    if (!setsUserAgent(args)) return result;

    const separator = result.stderr === '' || result.stderr.endsWith('\n') ? '' : '\n';
    return { ...result, stderr: `${result.stderr}${separator}${WARNING}` };
  });
}

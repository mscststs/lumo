/**
 * Injection contract between the tool layer and the page content script.
 *
 * The script is registered at runtime rather than in the manifest, so the *only*
 * thing that loads it is `sendToContent`'s inject-and-retry. That makes the file
 * path a real coupling: if WXT's output location changes, or the entrypoint's
 * `registration` is flipped back to declarative, page tools break on every tab
 * that has not already been injected — and they break at run time, on a user's
 * page, not in CI. These tests pin both halves down.
 *
 * Why runtime registration at all: an MV3 content script is a classic script, so
 * the bundler must inline the dynamic `import()` of Readability + Turndown
 * instead of emitting a lazy chunk. Declaring it in the manifest would parse
 * ~24KB gzip on every page visited, which is the cost the spec's lazy-loading
 * risk mitigation was meant to avoid.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('content script injection contract', () => {
  it('registers the page content script at runtime, not in the manifest', () => {
    expect(read('entrypoints/content.ts')).toContain("registration: 'runtime'");
  });

  it('injects the exact path WXT emits the script to', () => {
    const server = read('lib/mcp/page-interact-server.ts');
    // WXT names content script output after the entrypoint file.
    expect(server).toContain("const CONTENT_SCRIPT_FILE = 'content-scripts/content.js'");
  });

  it('retries the message after injecting rather than failing outright', () => {
    const server = read('lib/mcp/page-interact-server.ts');
    const sendToContent = server.slice(
      server.indexOf('private async sendToContent'),
      server.indexOf('private async requestPage'),
    );
    expect(sendToContent).toContain('executeScript');
    expect(sendToContent).toContain(CONTENT_SCRIPT_FILE_REFERENCE);
    // The failure message has to name the escape hatch; a bare "failed" makes the
    // model retry the same unusable call.
    expect(sendToContent).toContain('page_get_text');
  });

  it('keys injection off an absent response, not a thrown error', () => {
    const server = read('lib/mcp/page-interact-server.ts');
    const sendToContent = server.slice(
      server.indexOf('private async sendToContent'),
      server.indexOf('private async requestPage'),
    );
    // `chrome.tabs.sendMessage` resolves as soon as *any* listener exists, and
    // the WebMCP bridge already registers one on every page. A listener declining
    // a foreign message still resolves the call, with `undefined`. Keying
    // injection off a rejection therefore never injects, and every page tool
    // fails on every tab — the regression this pins down.
    expect(sendToContent).toContain('PageResponse | undefined');
    expect(sendToContent).toMatch(/if \(first\) return first/);
  });

  it('guards the content script against answering twice', () => {
    // Injection is retried per unanswered request, so the file can land in one
    // document more than once. Two listeners answer the same message twice, and
    // Chrome closes the port after the first — surfacing a bogus error for a
    // request that worked.
    expect(read('entrypoints/content.ts')).toContain('__lumoPageScriptReady');
  });

  it('keeps the page protocol namespaced away from the WebMCP bridge', () => {
    // Both content scripts share chrome.runtime.onMessage.
    expect(read('lib/page/messages.ts')).toContain("PAGE_MESSAGE_PREFIX = 'lumo:page:'");
    expect(read('entrypoints/content.ts')).toContain('isPageRequest');
  });
});

const CONTENT_SCRIPT_FILE_REFERENCE = 'CONTENT_SCRIPT_FILE';

/**
 * How WXT *types* each entrypoint, which is decided by file name alone.
 *
 * Only `content.ts` / `*.content.ts` become content scripts. The two WebMCP
 * entrypoints are named neither, so WXT builds them as unlisted scripts and
 * invokes `main()` with no arguments. Declaring them with `defineContentScript`
 * compiles, type-checks, and then crashes on every page with "Cannot read
 * properties of undefined (reading 'onInvalidated')" the moment the body touches
 * the `ctx` the signature promises. It also makes the `matches` / `world` /
 * `runAt` / `registration` keys look meaningful when WXT discards them — the
 * real registration is hand-written in `webmcp-manager.ts`.
 */
describe('entrypoint type contract', () => {
  /**
   * Strip comments before asserting. These files *explain* why they are not
   * content scripts, so the forbidden strings legitimately appear in prose.
   */
  function code(relative: string): string {
    return read(relative)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  const UNLISTED = [
    'entrypoints/content-webmcp-bridge.ts',
    'entrypoints/content-webmcp-main.ts',
  ];

  it.each(UNLISTED)('%s declares itself an unlisted script', (file) => {
    const source = code(file);
    expect(source).toContain('defineUnlistedScript');
    expect(source).not.toContain('defineContentScript');
  });

  it.each(UNLISTED)('%s carries no ignored content-script config', (file) => {
    const source = code(file);
    // These keys are silently dropped for unlisted scripts. Keeping them
    // documents a registration that never happens.
    for (const key of ['matches:', 'registration:', 'runAt:', 'world:']) {
      expect(source).not.toContain(key);
    }
  });

  it.each(UNLISTED)('%s takes no context parameter', (file) => {
    // WXT calls `main()` with nothing for an unlisted script.
    const source = code(file);
    expect(source).toMatch(/defineUnlistedScript\(\(\) =>/);
  });

  it('keeps the page entrypoint a real content script', () => {
    // `content.ts` *does* match WXT's naming rule, so it legitimately gets the
    // declarative form and a `ContentScriptContext`.
    expect(code('entrypoints/content.ts')).toContain('defineContentScript');
  });

  it('injects the WebMCP scripts from the paths WXT emits them to', () => {
    // An unlisted script lands at the output root, not under content-scripts/.
    const manager = code('lib/mcp/webmcp-manager.ts');
    expect(manager).toContain("'content-webmcp-bridge.js'");
    expect(manager).toContain("'content-webmcp-main.js'");
    expect(manager).not.toContain('content-scripts/content-webmcp');
  });
});

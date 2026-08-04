import { isPageRequest, type PageRequest, type PageResponse } from '@/lib/page/messages';

/**
 * Content script hosting the page-reading pipeline.
 *
 * Why a content script rather than `chrome.scripting.executeScript({ func })`:
 *  1. Readability/Turndown are modules; an injected function is serialised and
 *     cannot import anything.
 *  2. The ref registry must survive *between* calls — a ref handed out by
 *     `page_snapshot` has to resolve during a later `page_click`. Injecting a
 *     *file* gives us a module scope that lives as long as the document, which a
 *     serialised function never does.
 *
 * `registration: 'runtime'` keeps this out of the manifest, so it is injected the
 * first time a page tool is used on a tab and never otherwise. That is not a
 * micro-optimisation: an MV3 content script is a classic script, so Vite has to
 * inline the `import()` of Readability + Turndown rather than emit a separate
 * chunk. Declaring it in the manifest would therefore parse ~24KB gzip on every
 * page the user visits, whether or not they ever ask about it. Injection is
 * driven by `PageInteractMcpServer.sendToContent`, which already retries after
 * injecting when no receiver answers.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  registration: 'runtime',
  main() {
    // Injection is retried whenever a request goes unanswered, so the same file
    // can land in a document more than once. A second listener would answer the
    // same message a second time, and Chrome closes the port after the first
    // response — producing a spurious "message port closed" error for a request
    // that actually succeeded.
    const guard = window as typeof window & { __lumoPageScriptReady?: boolean };
    if (guard.__lumoPageScriptReady) return;
    guard.__lumoPageScriptReady = true;

    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!isPageRequest(message)) {
        return false; // not ours — let other listeners handle it
      }
      handle(message)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies PageResponse),
        );
      return true; // async response
    });
  },
});

async function handle(message: PageRequest): Promise<PageResponse> {
  const handlers = await import('@/lib/page/handlers');
  return handlers.handlePageRequest(message);
}

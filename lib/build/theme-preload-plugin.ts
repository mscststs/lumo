import type { Plugin } from 'vite';

/** Public path of the script, served from `public/`. */
const PRELOAD_SRC = '/theme-preload.js';

/**
 * Injects the first-paint theme script into every HTML entrypoint.
 *
 * Exists so anti-FOUC is a property of the build rather than a line each page
 * has to remember. The tag was originally pasted into all three `index.html`
 * files, which meant a new entrypoint silently shipped with the white flash —
 * the failure is invisible on a light theme and easy to miss in review.
 *
 * `head-prepend` is required, not cosmetic: the script must run before the app
 * bundle mounts React, and before the stylesheet so it can paint the canvas
 * itself. Vite emits it without `type="module"`, so it stays synchronous —
 * a module script is implicitly deferred and would land after first paint,
 * restoring the flash while still looking correct in the HTML.
 */
export function themePreloadPlugin(): Plugin {
  return {
    name: 'lumo:theme-preload',
    transformIndexHtml: {
      // Run before other HTML transforms so nothing can slip ahead of it.
      order: 'pre',
      handler(html: string) {
        // Idempotent: WXT runs the HTML transform twice (once for the file it
        // writes to `.output`, once for the dev-server response), and the same
        // Vite plugin participates in both. Without the guard the script would
        // be emitted twice — harmless at runtime but wrong, and a build that
        // duplicates a tag is one edit away from triplicating it.
        if (html.includes(PRELOAD_SRC)) return [];
        return [
          {
            tag: 'script',
            attrs: { src: PRELOAD_SRC },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

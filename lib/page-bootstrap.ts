import { applyLanguage, watchLanguageChanges } from '@/i18n';
import { applyTheme } from '@/lib/theme';
import { normalizeTheme } from '@/lib/theme-registry';
import { storage } from '@/store/storage';

/**
 * Everything that must be settled before an extension page renders its first
 * frame — and deliberately nothing else.
 *
 * Two things qualify: the UI language (text rendered in the wrong language then
 * swapped is worse than a slightly later first frame) and the theme (a light
 * frame repainted dark is the flash this module exists to remove). Both live in
 * the single `uiSettings` record, so one read serves both. Previously they were
 * read separately — i18n in its own initialiser, the theme again inside
 * `ThemeInit`'s effect — which made cold start the *sum* of two round trips and
 * pushed the theme until after React had already mounted and painted.
 *
 * Anything that is not required for a correct first frame belongs after render,
 * behind its own loading state. `initBuiltinMcpServers` used to be awaited here:
 * it connects external MCP servers over the network with no timeout
 * (`lib/mcp/external-server.ts`), so one unreachable server held the side panel
 * on a blank page indefinitely.
 */
export async function bootstrapPage(): Promise<void> {
  try {
    const settings = await storage.getUISettings();
    await applyLanguage(settings.language);
    applyTheme(normalizeTheme(settings.theme));
  } catch (error) {
    // Render with defaults rather than not at all. `theme-preload.js` has
    // already painted the mirrored palette, so a failure here is usually
    // invisible; `ThemeInit` retries the read once mounted.
    console.error('[Lumo] Failed to bootstrap page settings:', error);
  }

  watchLanguageChanges();
}

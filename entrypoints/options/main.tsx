import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { bootstrapPage } from '@/lib/page-bootstrap';
import { installExtensionRetry } from '@/lib/mcp/extension-retry';
import { connectAllInBackground, initMcpRegistry } from '@/lib/mcp';

/**
 * Approving an extension provider happens in that extension's own settings tab.
 * The options page shows the same provider cards the side panel does, so it has
 * to recover from a grant the same way: one shared, throttled retry instead of a
 * per-page copy. Without it, returning from the approval tab left the card on
 * "waiting for approval" until the user found the Reconnect button.
 */
installExtensionRetry();

// The options page used to only `import '@/i18n'`, which initialises i18next
// from the *browser* language and skips the stored preference. A user who chose
// 中文 in this page would therefore see it revert to English the next time they
// opened it. `bootstrapPage()` applies the persisted language (and theme, font)
// before the first frame, exactly as the side panel already does.
//
// Registry *registration* is awaited alongside it: it is local work (one
// settings read plus constructors), and every card in `#mcp`, plus the counts
// above them, is derived from it. Rendering before it finished would paint an
// empty server list for a frame. Registration used to be welded to the
// connection pass, which is why the page appeared to be loading "forever" — a
// remote MCP endpoint that accepted the handshake and then stalled kept the
// whole page on a spinner.
Promise.all([
  bootstrapPage(),
  initMcpRegistry().catch((error) => {
    // A degraded page (built-ins only) beats a blank one.
    console.error('[Lumo] Failed to register MCP servers:', error);
  }),
]).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  // Connections are network I/O and never gate a frame. Each server announces
  // its own `connecting → connected | error` through the registry subscription,
  // so the UI is live from the first paint and one slow endpoint only ever
  // delays its own card.
  connectAllInBackground();
});

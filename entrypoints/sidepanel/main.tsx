import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { initI18nFromStorage } from '@/i18n';
import { initBuiltinMcpServers } from '@/lib/mcp';

/**
 * Last-resort visibility for rejections nothing else caught.
 *
 * A quota failure on the send path used to surface only as
 * `Uncaught (in promise) Error: Resource::kQuotaBytes quota exceeded`, with no
 * indication of which operation had died. The individual call sites now handle
 * their own failures; this keeps anything still slipping through attributable.
 */
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Lumo] Unhandled promise rejection:', event.reason);
});

// The legacy `conversations` key is dropped by the background script, which runs
// before any extension page — see `entrypoints/background.ts`.
Promise.all([initI18nFromStorage(), initBuiltinMcpServers()]).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { bootstrapPage } from '@/lib/page-bootstrap';

// The options page used to only `import '@/i18n'`, which initialises i18next
// from the *browser* language and skips the stored preference. A user who chose
// 中文 in this page would therefore see it revert to English the next time they
// opened it. `bootstrapPage()` applies the persisted language (and theme, font)
// before the first frame, exactly as the side panel already does.
bootstrapPage().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { initI18nFromStorage } from '@/i18n';
import { initBuiltinMcpServers } from '@/lib/mcp';

Promise.all([initI18nFromStorage(), initBuiltinMcpServers()]).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

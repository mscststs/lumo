import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { bootstrapPage } from '@/lib/page-bootstrap';

bootstrapPage().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

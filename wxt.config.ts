import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    disabled: true,
  },
  manifest: {
    name: 'Lumo',
    description: 'AI-powered browser sidebar assistant',
    permissions: [
      'sidePanel',
      'storage',
      'activeTab',
      'tabs',
      'bookmarks',
      'history',
      'scripting',
      'webNavigation',
      'webRequest',
      'declarativeNetRequest',
      'cookies',
      'downloads',
      'debugger',
      'tabGroups',
    ],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: 'Open Lumo Sidebar',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname),
      },
    },
  }),
});

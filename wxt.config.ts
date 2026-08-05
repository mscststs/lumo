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
      'contextMenus',
    ],
    host_permissions: ['<all_urls>'],
    sandbox: {
      pages: ['sandbox.html'],
    },
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
    build: {
      // Chrome 拒绝复用跨 script world 的 chrome-extension:// 预加载资源
      // (Resource::CanReuse -> kCrossWorldExtensionResourceMismatch)，导致
      // 扩展页面每次加载都刷出 "cross-world extension resource mismatch" 与
      // "preloaded but not used" 警告。扩展资源是本地读取，modulepreload
      // 省不下网络 RTT，且各入口的 chunk 均为直接静态依赖，故直接关闭。
      modulePreload: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname),
      },
    },
  }),
});

/**
 * WebMCP Background Manager
 *
 * Manages the lifecycle of WebMCP content script injection and tool state.
 * Runs in the background service worker.
 *
 * Responsibilities:
 * - Monitor webmcpEnabled setting and dynamically register/unregister content scripts
 * - Receive tool reports from content scripts
 * - Maintain per-tab tool state in session storage
 * - Clean up state when tabs close or navigate
 * - Notify other contexts of state changes
 */

import type { WebMcpTabState, WebMcpToolInfo } from './types';
import type { WebMcpContentMessage } from './webmcp-messages';
import { WEBMCP_SESSION_KEY } from './webmcp-messages';
import { storage } from '@/store/storage';

// ============================================================================
// State
// ============================================================================

/** In-memory cache of tab states for fast access */
const tabStates = new Map<number, WebMcpTabState>();

/** Whether WebMCP is currently active */
let webmcpActive = false;

/** Content script IDs for dynamic registration */
const BRIDGE_SCRIPT_ID = 'lumo-webmcp-bridge';
const MAIN_SCRIPT_ID = 'lumo-webmcp-main';

// ============================================================================
// Session Storage Sync
// ============================================================================

/**
 * Persist current tab states to session storage for cross-context access.
 */
async function persistTabStates(): Promise<void> {
  const states = Array.from(tabStates.values());
  await chrome.storage.session.set({ [WEBMCP_SESSION_KEY]: states });
}

/**
 * Get all current WebMCP tab states (for use in other contexts).
 */
export async function getWebMcpTabStates(): Promise<WebMcpTabState[]> {
  const result = await chrome.storage.session.get(WEBMCP_SESSION_KEY);
  return (result[WEBMCP_SESSION_KEY] as WebMcpTabState[] | undefined) || [];
}

// ============================================================================
// Content Script Registration
// ============================================================================

/**
 * Register the WebMCP content scripts dynamically.
 */
async function registerContentScripts(): Promise<void> {
  try {
    // First, try to unregister in case they already exist
    await unregisterContentScripts();

    await chrome.scripting.registerContentScripts([
      {
        id: BRIDGE_SCRIPT_ID,
        matches: ['<all_urls>'],
        js: ['content-webmcp-bridge.js'],
        runAt: 'document_start',
        world: 'ISOLATED' as any,
        allFrames: false,
      },
      {
        id: MAIN_SCRIPT_ID,
        matches: ['<all_urls>'],
        js: ['content-webmcp-main.js'],
        runAt: 'document_start',
        world: 'MAIN' as any,
        allFrames: false,
      },
    ]);

    console.log('[Lumo WebMCP] Content scripts registered');
  } catch (err) {
    console.error('[Lumo WebMCP] Failed to register content scripts:', err);
  }
}

/**
 * Unregister WebMCP content scripts.
 */
async function unregisterContentScripts(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [BRIDGE_SCRIPT_ID, MAIN_SCRIPT_ID],
    });
  } catch {
    // Scripts may not be registered - ignore
  }
}

/**
 * Inject WebMCP scripts into all existing tabs (for when feature is first enabled).
 */
async function injectIntoExistingTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      // Skip chrome:// and extension pages
      if (
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('about:') ||
        tab.url.startsWith('edge://')
      ) {
        continue;
      }

      try {
        // Inject bridge (ISOLATED world)
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-webmcp-bridge.js'],
        });

        // Inject main (MAIN world)
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-webmcp-main.js'],
          world: 'MAIN' as any,
        });
      } catch {
        // Tab may not be injectable (e.g. chrome:// pages) - skip
      }
    }
  } catch (err) {
    console.error('[Lumo WebMCP] Failed to inject into existing tabs:', err);
  }
}

// ============================================================================
// Message Handling
// ============================================================================

/**
 * Handle messages from WebMCP content scripts.
 */
function handleWebMcpMessage(
  message: WebMcpContentMessage,
  sender: chrome.runtime.MessageSender,
): void {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  switch (message.type) {
    case 'webmcp:tools-report': {
      const state: WebMcpTabState = {
        tabId,
        title: message.pageTitle || sender.tab?.title || '',
        url: message.pageUrl || sender.tab?.url || '',
        tools: message.tools,
        lastUpdated: Date.now(),
      };
      tabStates.set(tabId, state);
      persistTabStates();
      break;
    }

    case 'webmcp:heartbeat': {
      if (!tabStates.has(tabId)) {
        const state: WebMcpTabState = {
          tabId,
          title: message.pageTitle || sender.tab?.title || '',
          url: message.pageUrl || sender.tab?.url || '',
          tools: [],
          lastUpdated: Date.now(),
        };
        tabStates.set(tabId, state);
        persistTabStates();
      }
      break;
    }

    case 'webmcp:unload': {
      tabStates.delete(tabId);
      persistTabStates();
      break;
    }
  }
}

// ============================================================================
// Tab Lifecycle
// ============================================================================

/**
 * Set up listeners for tab lifecycle events.
 */
function setupTabLifecycleListeners(): void {
  // Clean up when a tab is closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabStates.has(tabId)) {
      tabStates.delete(tabId);
      persistTabStates();
    }
  });

  // Clean up / re-request when a tab navigates
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && tabStates.has(tabId)) {
      // Page is navigating - clear old tools, new ones will be reported after injection
      tabStates.delete(tabId);
      persistTabStates();
    }
  });
}

// ============================================================================
// Enable / Disable
// ============================================================================

/**
 * Enable WebMCP monitoring.
 */
async function enableWebMcp(): Promise<void> {
  if (webmcpActive) return;
  webmcpActive = true;

  await registerContentScripts();
  await injectIntoExistingTabs();
  setupTabLifecycleListeners();

  console.log('[Lumo WebMCP] Enabled');
}

/**
 * Disable WebMCP monitoring.
 */
async function disableWebMcp(): Promise<void> {
  if (!webmcpActive) return;
  webmcpActive = false;

  await unregisterContentScripts();

  // Clear all tab states
  tabStates.clear();
  await persistTabStates();

  console.log('[Lumo WebMCP] Disabled');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the WebMCP background manager.
 * Call this once from the background service worker.
 */
export function initWebMcpManager(): void {
  // Set up message listener for WebMCP content script messages
  chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (!message.type?.startsWith('webmcp:')) return false;

    handleWebMcpMessage(message as WebMcpContentMessage, sender);
    return false;
  });

  // Set up tab lifecycle listeners (always active for cleanup)
  setupTabLifecycleListeners();

  // Check initial state and enable if needed
  storage.getMcpSettings().then((settings) => {
    if (settings.webmcpEnabled) {
      enableWebMcp();
    }
  });

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.mcpSettings) return;

    const newSettings = changes.mcpSettings.newValue as
      | { webmcpEnabled?: boolean }
      | undefined;

    if (!newSettings) return;

    if (newSettings.webmcpEnabled && !webmcpActive) {
      enableWebMcp();
    } else if (!newSettings.webmcpEnabled && webmcpActive) {
      disableWebMcp();
    }
  });
}

/**
 * Execute a WebMCP tool on a specific tab.
 */
export async function executeWebMcpTool(
  tabId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; result?: string; error?: string }> {
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    // Set a timeout in case the content script doesn't respond
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Tool execution timed out' });
    }, 30000);

    chrome.tabs
      .sendMessage(tabId, {
        type: 'webmcp:execute-tool',
        executionId,
        toolName,
        args: JSON.stringify(args),
      })
      .then((response) => {
        clearTimeout(timeout);
        if (response && typeof response === 'object') {
          resolve(response);
        } else {
          resolve({ success: false, error: 'No response from content script' });
        }
      })
      .catch((err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

/**
 * Request a specific tab to re-report its tools.
 */
export async function requestToolsFromTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'webmcp:request-tools' });
  } catch {
    // Tab may not have the content script - ignore
  }
}

/**
 * Check if WebMCP is currently active.
 */
export function isWebMcpActive(): boolean {
  return webmcpActive;
}

/**
 * Get in-memory tab states (background-only, for fast access).
 */
export function getTabStatesInMemory(): WebMcpTabState[] {
  return Array.from(tabStates.values());
}

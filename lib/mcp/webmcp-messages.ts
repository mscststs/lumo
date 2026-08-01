/**
 * WebMCP messaging protocol between content script and background service worker.
 *
 * Content script (MAIN world) discovers tools via document.modelContext,
 * then reports them to the background via chrome.runtime.sendMessage.
 * Background maintains the authoritative tab→tools state in session storage.
 */

import type { WebMcpToolInfo } from './types';

// ============================================================================
// Content Script → Background messages
// ============================================================================

/**
 * Report the full list of tools available on the current page.
 * Sent on initial discovery and whenever the toolset changes.
 */
export interface WebMcpToolsReportMessage {
  type: 'webmcp:tools-report';
  tools: WebMcpToolInfo[];
  pageTitle: string;
  pageUrl: string;
}

/**
 * Notify background that the content script is alive and monitoring.
 * Used as a heartbeat / initial handshake.
 */
export interface WebMcpHeartbeatMessage {
  type: 'webmcp:heartbeat';
  hasModelContext: boolean;
  pageTitle: string;
  pageUrl: string;
}

/**
 * Content script is being unloaded (page navigation / close).
 */
export interface WebMcpUnloadMessage {
  type: 'webmcp:unload';
}

export type WebMcpContentMessage =
  | WebMcpToolsReportMessage
  | WebMcpHeartbeatMessage
  | WebMcpUnloadMessage;

// ============================================================================
// Background → Content Script messages
// ============================================================================

/**
 * Request the content script to re-report its current tool list.
 */
export interface WebMcpRequestToolsMessage {
  type: 'webmcp:request-tools';
}

/**
 * Request the content script to execute a specific tool.
 */
export interface WebMcpExecuteToolMessage {
  type: 'webmcp:execute-tool';
  toolName: string;
  args: string; // JSON stringified arguments
  executionId: string;
}

export type WebMcpBackgroundMessage =
  | WebMcpRequestToolsMessage
  | WebMcpExecuteToolMessage;

// ============================================================================
// Background → Content Script response for tool execution
// ============================================================================

export interface WebMcpExecuteToolResponse {
  success: boolean;
  result?: string; // JSON stringified result
  error?: string;
}

// ============================================================================
// Session storage key for WebMCP tab states
// ============================================================================

export const WEBMCP_SESSION_KEY = 'webmcp:tabStates';

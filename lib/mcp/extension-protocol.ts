/**
 * L0 contract between Lumo and an extension that provides MCP capabilities.
 *
 * The probe is deliberately the *only* custom message. Everything after a
 * successful probe is standard MCP over a `chrome.runtime` Port, implemented by
 * `@ai-sdk/mcp` on this side and by the official SDK on the provider side.
 */

export const PROBE_CHANNEL = 'lumo:probe';
export const PROBE_VERSION = 1;
export const MCP_PORT_NAME = 'lumo:mcp';

export interface ProbeRequest {
  channel: typeof PROBE_CHANNEL;
  version: number;
  id?: string;
  client?: { id: string; name: string; version: string };
}

export interface ExtensionServiceInfo {
  namespace: string;
  name: string;
  version: string;
}

export interface ExtensionStatus {
  enabled: boolean;
  authorized: boolean;
  ready: boolean;
  /** The provider is waiting for the user to approve this extension. */
  pendingApproval?: boolean;
  reason?: { code: string; message: string };
}

export interface ProbeResponse {
  ok: boolean;
  service?: ExtensionServiceInfo;
  status?: ExtensionStatus;
  error?: { code: string; message: string };
}

export function isProbeResponse(value: unknown): value is ProbeResponse {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** Chrome extension IDs are 32 characters drawn from `a`–`p`. */
export function isExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value);
}

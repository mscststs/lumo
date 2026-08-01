import {
  networkLog,
  consoleLog,
  attachedTabs,
  type NetworkRequestRecord,
  type ConsoleMessageRecord,
} from './session-store';

/**
 * Background-only event collectors.
 *
 * These listeners must be registered in the service worker, synchronously at
 * startup: registering them from the side panel means they stop the moment the
 * panel closes, and registering them after an `await` means events fired during
 * the service worker's cold start are dropped.
 *
 * The collectors only write to session storage; the MCP tools that read it are
 * plain storage readers and stay context-agnostic.
 */

/** Coalesce bursty events into one storage write per tick. */
class BatchWriter<T> {
  private pending: T[] = [];
  private scheduled = false;

  constructor(private readonly flush: (items: T[]) => Promise<void>) {}

  push(item: T): void {
    this.pending.push(item);
    if (this.scheduled) return;
    this.scheduled = true;
    // A page load can fire hundreds of webRequest events; writing per event
    // would serialise the whole buffer hundreds of times.
    setTimeout(() => {
      const batch = this.pending;
      this.pending = [];
      this.scheduled = false;
      void this.flush(batch).catch((error) => {
        console.error('[Lumo] Failed to persist MCP session log:', error);
      });
    }, 200);
  }
}

function headersToRecord(
  headers?: chrome.webRequest.HttpHeader[],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string> = {};
  for (const header of headers) {
    if (header.value) record[header.name.toLowerCase()] = header.value;
  }
  return record;
}

function registerNetworkCollector(): void {
  if (!chrome.webRequest) return;

  const writer = new BatchWriter<NetworkRequestRecord>((items) =>
    networkLog.append(items),
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      writer.push({
        id: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        timestamp: details.timeStamp,
        fromCache: details.fromCache,
        ip: details.ip,
        initiator: details.initiator,
        responseHeaders: headersToRecord(details.responseHeaders),
      });
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      writer.push({
        id: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        timestamp: details.timeStamp,
        initiator: details.initiator,
        error: details.error,
      });
    },
    { urls: ['<all_urls>'] },
  );
}

function toConsoleRecord(
  method: string,
  params?: unknown,
): ConsoleMessageRecord | undefined {
  const p = params as Record<string, unknown> | undefined;
  if (!p) return undefined;

  if (method === 'Runtime.consoleAPICalled') {
    const args = p.args as
      | Array<{ type: string; value?: unknown; description?: string }>
      | undefined;
    const text =
      args
        ?.map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
        .join(' ') || '';
    return {
      level: (p.type as string) || 'log',
      text,
      timestamp: Date.now(),
      stackTrace: p.stackTrace ? JSON.stringify(p.stackTrace) : undefined,
    };
  }

  if (method === 'Runtime.exceptionThrown') {
    const exception = p.exceptionDetails as
      | { text?: string; url?: string; lineNumber?: number; columnNumber?: number }
      | undefined;
    return {
      level: 'error',
      text: exception?.text || 'Exception thrown',
      url: exception?.url,
      lineNumber: exception?.lineNumber,
      columnNumber: exception?.columnNumber,
      timestamp: Date.now(),
    };
  }

  return undefined;
}

function registerDebuggerCollector(): void {
  if (!chrome.debugger) return;

  const writer = new BatchWriter<ConsoleMessageRecord>((items) =>
    consoleLog.append(items),
  );

  chrome.debugger.onEvent.addListener((_source, method, params) => {
    const record = toConsoleRecord(method, params);
    if (record) writer.push(record);
  });

  // Detach can be triggered by the user closing the infobar or by the tab
  // going away, so the shared attach set has to be reconciled here.
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      void attachedTabs.remove(source.tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void attachedTabs.remove(tabId);
  });
}

/**
 * Register every long-lived collector. Call synchronously from the background
 * entrypoint; safe to call once per service worker start.
 */
export function registerMcpCollectors(): void {
  if (typeof chrome === 'undefined') return;
  registerNetworkCollector();
  registerDebuggerCollector();
}

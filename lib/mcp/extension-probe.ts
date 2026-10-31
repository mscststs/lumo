import {
  PROBE_CHANNEL,
  PROBE_VERSION,
  isProbeResponse,
  type ProbeResponse,
} from './extension-protocol';

const PROBE_TIMEOUT_MS = 1500;

export interface ProbeOutcome {
  ok: boolean;
  response?: ProbeResponse;
  /** Human-readable reason when `ok` is false. */
  error?: string;
  /** True when the extension could not be reached at all. */
  unreachable?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timed out after ${ms} ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Ask one extension whether it exposes an agent endpoint.
 *
 * `sendMessage` rejects immediately when the extension is not installed or does
 * not declare `externally_connectable`; the UI renders that as "not installed"
 * rather than as an error the user must act on.
 */
export async function probeExtension(extensionId: string): Promise<ProbeOutcome> {
  const request = {
    channel: PROBE_CHANNEL,
    version: PROBE_VERSION,
    id: crypto.randomUUID(),
    client: {
      id: chrome.runtime.id,
      name: 'Lumo',
      version: chrome.runtime.getManifest().version,
    },
  };

  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage(extensionId, request) as Promise<unknown>,
      PROBE_TIMEOUT_MS,
    );
    if (!isProbeResponse(response)) {
      return { ok: false, error: 'The extension returned a malformed probe response.' };
    }
    return {
      ok: response.ok,
      response,
      error: response.error?.message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message,
      unreachable: /Receiving end does not exist|Could not establish connection/i.test(message),
    };
  }
}

/**
 * Open a stored file in a single reusable preview tab.
 *
 * Preview pages are identified by their complete URL, including the encoded file
 * name. Keeping this behaviour in one place makes Agent, sidebar, and options
 * page previews behave identically.
 */

export interface FilePreviewTabResult {
  url: string;
  tab: chrome.tabs.Tab;
  reused: boolean;
}

/**
 * Calls for the same preview URL are serialized within an extension context.
 * Without this guard, two nearly simultaneous tool calls can both observe that
 * no tab exists and create duplicate preview tabs.
 */
const inFlightPreviews = new Map<string, Promise<FilePreviewTabResult>>();

export function filePreviewUrl(name: string): string {
  return chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`);
}

async function focusPreviewTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null) {
    throw new Error('Preview tab has no id');
  }

  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function openPreviewTab(url: string): Promise<FilePreviewTabResult> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url });
  } catch {
    // Creating the tab is still a useful fallback if querying tabs is
    // temporarily unavailable. Normal extension contexts have the `tabs`
    // permission, so this is only for degraded browser/API environments.
    tabs = [];
  }

  const existing = tabs.find((tab) => tab.id != null);
  if (existing) {
    try {
      await focusPreviewTab(existing);
      return { url, tab: existing, reused: true };
    } catch {
      // The tab may have been closed between query and update. Creating a new
      // tab is then correct; the next query will no longer find the stale tab.
    }
  }

  const created = await chrome.tabs.create({ url, active: true });
  return { url, tab: created, reused: false };
}

export async function openFilePreview(name: string): Promise<FilePreviewTabResult> {
  const url = filePreviewUrl(name);
  const pending = inFlightPreviews.get(url);
  if (pending) return pending;

  const request = openPreviewTab(url);
  inFlightPreviews.set(url, request);

  try {
    return await request;
  } finally {
    if (inFlightPreviews.get(url) === request) {
      inFlightPreviews.delete(url);
    }
  }
}

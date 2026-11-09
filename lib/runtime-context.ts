/**
 * Runtime context — the facts that change every turn.
 *
 * Two things the model cannot infer and previously had to pay a tool call for:
 *
 *  - **The active tab.** Without it "summarize this page" starts with
 *    `browser_tabs list`, or worse with a guessed `tabId` that acts on whichever
 *    tab happens to be active when the request lands. `lib/page-context.ts`
 *    already hands the model a `tabId` for right-click quick actions; this is the
 *    same fact for every ordinary message.
 *  - **The current time.** Kept out of the user's prompt on purpose. It used to
 *    be prepended by `resolveSystemPrompt`, which meant the conversation snapshot
 *    froze the timestamp of the *first* message and every later turn was told
 *    that time had stopped. It is now derived per request, and the prompt
 *    snapshot stays byte-identical across turns.
 *
 * This section goes last: it is the only part of the system prompt that changes
 * between turns, so keeping it at the end leaves the widest possible stable
 * prefix for a provider's prefix cache.
 */

export interface ActiveTabInfo {
  id: number;
  title?: string;
  url?: string;
}

export interface RuntimeContext {
  /** Local time to report, or `undefined` when the user turned it off. */
  now?: Date;
  tab?: ActiveTabInfo;
}

const MAX_TITLE_CHARS = 120;
const MAX_URL_CHARS = 300;

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** `YYYY-MM-DD HH:mm:ss` in local time — the format the prompt always used. */
export function formatTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * The active tab of the window the user is looking at.
 *
 * Fails silently: a page without `tabs` permission, a background context, or the
 * node test environment all just mean "no tab to report", which must never fail
 * a turn.
 */
export async function readActiveTab(): Promise<ActiveTabInfo | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return undefined;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return undefined;
    return {
      id: tab.id,
      ...(tab.title ? { title: clip(tab.title, MAX_TITLE_CHARS) } : {}),
      ...(tab.url ? { url: clip(tab.url, MAX_URL_CHARS) } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Render the section, or `undefined` when there is nothing to report.
 *
 * The `tabId` is stated as the value the page/browser tools take, because that
 * is the only reason it is worth the tokens.
 */
export function formatRuntimeContext(context: RuntimeContext): string | undefined {
  const lines: string[] = [];
  if (context.now) lines.push(`CurrentTime: ${formatTimestamp(context.now)}`);
  const tab = context.tab;
  if (tab) {
    const label = [tab.title, tab.url].filter(Boolean).join(' — ');
    lines.push(
      `Active tab: ${tab.id}${label ? ` — ${label}` : ''} (pass tabId ${tab.id} to page_* / browser_* tools to act on it)`,
    );
  }
  if (lines.length === 0) return undefined;
  return `## Runtime context\n${lines.join('\n')}`;
}

/**
 * `evaluateViaCDP`'s one-shot debugger lifecycle.
 *
 * `page_evaluate` attaches the debugger only to run a single `Runtime.evaluate`,
 * so it must release the attachment afterwards — otherwise the shared
 * `attachedTabs` set and the tab's "debugging" infobar leak. But it must only
 * release an attachment *it* made, never one owned by another context (DevTools
 * Advanced, an explicit `debug_attach`), or it would yank a live session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageInteractMcpServer } from '@/lib/mcp/page-interact-server';
import { attachedTabs } from '@/lib/mcp/session-store';

function runWithDebugger(host: PageInteractMcpServer, tabId: number, fn: () => Promise<unknown>): Promise<unknown> {
  return (host as never as { runWithDebugger: <T>(tabId: number, fn: () => Promise<T>) => Promise<T> }).runWithDebugger(tabId, fn);
}

function installChrome(attachThrows = false) {
  const attach = vi.fn(async () => {
    if (attachThrows) throw new Error('Another debugger is already attached');
  });
  const detach = vi.fn();
  const sendCommand = vi.fn(async () => ({ result: { value: 42 } }));
  const storage = new Map<string, unknown>();

  (globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: { attach, detach, sendCommand },
    storage: {
      session: {
        async get(key: string) {
          return { [key]: storage.get(key) };
        },
        async set(payload: Record<string, unknown>) {
          for (const [key, value] of Object.entries(payload)) {
            storage.set(key, value);
          }
        },
      },
    },
    tabs: { query: async () => [{ id: 1 }] },
  };

  return { attach, detach, sendCommand };
}

afterEach(async () => {
  await attachedTabs.clear();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('runWithDebugger: releases only the attachment it made', () => {
  it('attaches, runs, and detaches when it owned the session', async () => {
    const { attach, detach } = installChrome();
    const server = new PageInteractMcpServer();

    const result = await runWithDebugger(server, 7, () => Promise.resolve('ok'));

    expect(result).toBe('ok');
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(await attachedTabs.has(7)).toBe(false);
  });

  it('leaves a session alone when another context attached first', async () => {
    const { attach, detach } = installChrome();
    await attachedTabs.add(7);
    const server = new PageInteractMcpServer();

    await runWithDebugger(server, 7, () => Promise.resolve('ok'));

    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(await attachedTabs.has(7)).toBe(true);
  });

  it('detaches even when the operation throws', async () => {
    const { detach } = installChrome();
    const server = new PageInteractMcpServer();

    await expect(runWithDebugger(server, 7, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(detach).toHaveBeenCalledTimes(1);
    expect(await attachedTabs.has(7)).toBe(false);
  });

  it('does not detach when another context attached mid-flight', async () => {
    // attach() fails with "already attached" → the session is not ours.
    const { attach, detach } = installChrome(true);
    attach.mockClear();
    const server = new PageInteractMcpServer();

    await runWithDebugger(server, 7, () => Promise.resolve('ok'));

    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
    expect(await attachedTabs.has(7)).toBe(false);
  });
});
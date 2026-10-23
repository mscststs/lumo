/**
 * Regression: the summarizer used to build its provider without a routing
 * session, so OpenCode rejected every `/compact` with
 * "Request is missing x-opencode-session". The summary must carry a session.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateCompactionSummary } from '@/lib/ai';
import type { ChatMessage, ModelConfig, ProviderConfig } from '@/types';

const provider: ProviderConfig = {
  id: 'p1',
  name: 'OpenCode',
  type: 'openai-chat',
  vendor: 'opencode',
  apiKey: 'k',
  models: [],
};

const model: ModelConfig = {
  id: 'm1',
  modelId: 'gpt-4o',
  displayName: 'GPT-4o',
  isVision: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (headers && typeof headers === 'object') {
    return (headers as Record<string, string>)[name];
  }
  return undefined;
}

describe('generateCompactionSummary on OpenCode', () => {
  it('sends a routing session header', async () => {
    const sessions: Array<string | undefined> = [];

    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      sessions.push(headerOf(init, 'x-opencode-session'));
      return new Response(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'SUMMARY' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi', state: 'done' }], timestamp: 1 },
    ];

    const result = await generateCompactionSummary({
      provider,
      model,
      messages,
      conversationId: 'conv-1',
    });

    expect(result.text).toBe('SUMMARY');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^ses_[0-9a-f]{64}$/);
  });
});

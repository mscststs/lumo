/**
 * Gateway thinking recovery.
 *
 * `@ai-sdk/openai`'s Chat-Completions parser reads only `content`,
 * `tool_calls` and `annotations` from a delta, so the `reasoning_content` that
 * compatible gateways stream never reaches Lumo — even though
 * `usage.completion_tokens` bills it. That is what made the live speed read
 * ~100 T/s and then jump to ~400 T/s at settlement: the meter counted the
 * visible tail, the settled value counted every billed token.
 *
 * These tests pin both halves: the pure extraction, and an end-to-end run
 * against a real OpenAI-compatible SSE endpoint (local, no network) proving the
 * thinking lands in the transcript — and that without the transform it does
 * not, which is the bug.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextStreamPart, ToolSet } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { runAgentLoop } from '@/lib/ai';
import {
  gatewayReasoningTransform,
  reasoningTextFromRaw,
} from '@/lib/gateway-reasoning';
import type { StepMetrics } from '@/lib/step-metrics';
import type { ChatMessagePart } from '@/types';

const BASE = {
  id: 'chatcmpl-probe',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'probe',
};
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 24,
  total_tokens: 34,
};

function delta(value: Record<string, unknown>) {
  return { ...BASE, choices: [{ index: 0, delta: value }] };
}

const SSE_CHUNKS: unknown[] = [
  delta({ role: 'assistant', reasoning_content: '我先看一下' }),
  delta({ reasoning_content: '当前页面。' }),
  delta({ content: 'Reading the page now.' }),
  { ...BASE, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE },
  '[DONE]',
];

describe('reasoningTextFromRaw', () => {
  it('reads the gateway spellings', () => {
    expect(reasoningTextFromRaw(delta({ reasoning_content: 'thinking' }))).toBe('thinking');
    expect(reasoningTextFromRaw(delta({ reasoning: 'thinking' }))).toBe('thinking');
  });

  it('ignores chunks without thinking', () => {
    expect(reasoningTextFromRaw(delta({ content: 'hi' }))).toBeNull();
    expect(reasoningTextFromRaw(delta({ reasoning_content: '' }))).toBeNull();
    expect(reasoningTextFromRaw(delta({ reasoning_content: null }))).toBeNull();
    expect(reasoningTextFromRaw({ choices: [] })).toBeNull();
    expect(reasoningTextFromRaw({})).toBeNull();
    expect(reasoningTextFromRaw(null)).toBeNull();
    expect(reasoningTextFromRaw('data: [DONE]')).toBeNull();
  });
});

describe('gatewayReasoningTransform', () => {
  /**
   * Feed parts through one transform instance and collect its output.
   *
   * The input is typed loosely on purpose: these tests only care about the
   * part *types* the transform reacts to, not about the fat payloads of
   * `finish` / `finish-step`, which the transform passes through untouched.
   */
  async function run(parts: Array<Record<string, unknown>>): Promise<TextStreamPart<ToolSet>[]> {
    const transform = gatewayReasoningTransform<ToolSet>()({
      tools: {} as ToolSet,
      stopStream: () => {},
    });
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const out: TextStreamPart<ToolSet>[] = [];
    // Read concurrently: a TransformStream applies backpressure, so writing
    // everything before reading once would deadlock.
    const collected = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        out.push(value);
      }
    })();
    for (const part of parts) await writer.write(part as unknown as TextStreamPart<ToolSet>);
    await writer.close();
    await collected;
    return out;
  }

  it('rewrites reasoning deltas into one closed reasoning part, in order', async () => {
    const out = await run([
      { type: 'raw', rawValue: delta({ reasoning_content: 'a' }) },
      { type: 'raw', rawValue: delta({ reasoning_content: 'b' }) },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: 'hello' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: 'stop', totalUsage: {} as never },
    ]);

    expect(out.map((part) => part.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    const deltas = out.filter((part) => part.type === 'reasoning-delta');
    expect(deltas.map((part) => (part as { text: string }).text)).toEqual(['a', 'b']);
  });

  it('passes raw chunks it cannot use straight through', async () => {
    const raw = { type: 'raw', rawValue: delta({ content: 'hi' }) };
    expect(await run([raw])).toEqual([raw]);
  });

  it('closes a block at a tool call and opens a new one if thinking resumes', async () => {
    const out = await run([
      { type: 'raw', rawValue: delta({ reasoning_content: 'first' }) },
      { type: 'tool-input-start', id: 'call-1', toolName: 'echo' },
      { type: 'raw', rawValue: delta({ reasoning_content: 'second' }) },
      { type: 'finish-step' },
    ]);
    expect(
      out.filter((part) => part.type === 'reasoning-start').map((part) => part.id),
    ).toEqual(['gateway-reasoning-0', 'gateway-reasoning-1']);
    expect(out.filter((part) => part.type === 'reasoning-end')).toHaveLength(2);
  });
});

describe('runAgentLoop over an OpenAI-compatible gateway', () => {
  let server: Server | undefined;

  afterEach(() => {
    // Keep-alive sockets would keep `close()` pending forever; the suite must
    // never wait on a connection the SDK still holds.
    server?.closeAllConnections?.();
    server?.close();
    server = undefined;
  });

  /** Serve `SSE_CHUNKS` once and return the model that talks to it. */
  async function serve() {
    server = createServer((_req, res) => {
      // `connection: close` makes the SDK drop the socket once the stream ends,
      // so teardown is deterministic instead of waiting for an idle connection.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'close',
      });
      for (const chunk of SSE_CHUNKS) {
        res.write(typeof chunk === 'string' ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as { port: number }).port;
    const openai = createOpenAI({ apiKey: 'x', baseURL: `http://127.0.0.1:${port}/v1` });
    return openai.chat('probe');
  }

  it('puts the gateway thinking into the transcript and counts it in the live speed', async () => {
    const model = await serve();
    const events: StepMetrics[] = [];
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      gatewayReasoning: true,
      onMetrics: (metrics) => events.push(metrics),
    });

    const reasoning = result.parts.filter((part) => part.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0] as { text: string }).text).toBe('我先看一下当前页面。');

    // The thinking precedes the visible reply.
    const types = result.parts.map((part) => part.type);
    expect(types.indexOf('reasoning')).toBeLessThan(types.indexOf('text'));

    // The meter counts the same characters the transcript now carries, which is
    // what keeps the live value from jumping when the step settles.
    const streamed = result.parts
      .filter((part): part is ChatMessagePart & { text: string } =>
        part.type === 'text' || part.type === 'reasoning',
      )
      .map((part) => part.text.length)
      .reduce((sum, length) => sum + length, 0);
    expect(streamed).toBe('我先看一下当前页面。'.length + 'Reading the page now.'.length);

    expect(result.usage.steps?.[0]?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(events.some((event) => event.ttftMs !== null)).toBe(true);
  }, 15_000);

  it('drops the thinking without the transform — the bug this module fixes', async () => {
    const model = await serve();
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.parts.some((part) => part.type === 'reasoning')).toBe(false);
    // The provider still billed the thinking: this gap is the 4x TPS jump.
    expect(result.usage.outputTokens).toBe(USAGE.completion_tokens);
  }, 15_000);
});

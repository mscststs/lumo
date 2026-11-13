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

/**
 * The same reply as every compatible gateway actually frames it.
 *
 * `{role, content: ''}` is the role announcement, and the parser opens the call's
 * single text part on it because `content` is present, not because it is text.
 */
const ROLE_FRAME_CHUNKS: unknown[] = [
  delta({ role: 'assistant', content: '' }),
  delta({ reasoning_content: '我先看一下' }),
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

  it('holds the empty role-frame text part back so the thinking stays first', async () => {
    // The bug this guards: the parser opens the text part on the role frame's
    // empty `content`, so the reply's text part exists before any thinking and
    // the recovered reasoning is appended *after* the answer it preceded.
    const out = await run([
      { type: 'raw', rawValue: delta({ role: 'assistant', content: '' }) },
      { type: 'raw', rawValue: delta({ reasoning_content: 'a' }) },
      { type: 'raw', rawValue: delta({ reasoning_content: 'b' }) },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: '' },
      { type: 'text-delta', id: '0', text: 'hello' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: 'stop', totalUsage: {} as never },
    ]);

    expect(out.map((part) => part.type)).toEqual([
      // The role frame is not thinking, so it is passed through untouched — but
      // the text part it opened is not.
      'raw',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
    // The empty framing delta is replayed, but only *after* the start, and it
    // still leaves a single text part the answer streams into.
    const deltas = out.filter((part) => part.type === 'text-delta');
    expect(deltas.map((part) => (part as { text: string }).text)).toEqual(['', 'hello']);
  });

  it('emits no text part at all when only the framing ever arrives', async () => {
    const out = await run([
      { type: 'raw', rawValue: delta({ role: 'assistant', content: '' }) },
      { type: 'raw', rawValue: delta({ reasoning_content: 'a' }) },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: '' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: 'stop', totalUsage: {} as never },
    ]);

    // A thinking-only reply must not leave an empty part ahead of (or behind)
    // the reasoning block.
    expect(out.map((part) => part.type)).toEqual([
      'raw',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'finish',
    ]);
  });

  it('keeps one thinking block when a gateway puts thinking and empty content in one frame', async () => {
    // Same frame carries both: the raw is rewritten first, then the parser opens
    // the (empty) text part. The withheld start means the next thinking delta
    // continues the open block instead of opening one after the text.
    const out = await run([
      { type: 'raw', rawValue: delta({ reasoning_content: 'a', content: '' }) },
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
    expect(out.filter((part) => part.type === 'reasoning-start')).toHaveLength(1);
  });

  it('keeps a whitespace-only text part, which is framing the transcript always had', async () => {
    const out = await run([
      { type: 'raw', rawValue: delta({ reasoning_content: 'a' }) },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', text: '\n' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: 'stop', totalUsage: {} as never },
    ]);
    expect(out.map((part) => part.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
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

  /** Serve `chunks` once and return the model that talks to it. */
  async function serve(chunks: unknown[] = SSE_CHUNKS) {
    server = createServer((_req, res) => {
      // `connection: close` makes the SDK drop the socket once the stream ends,
      // so teardown is deterministic instead of waiting for an idle connection.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'close',
      });
      for (const chunk of chunks) {
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

  it('keeps the thinking ahead of the reply when the gateway opens with a role frame', async () => {
    // The shape every compatible gateway actually sends. Before the withheld
    // start, this produced `[text, reasoning]` — the thinking rendered below the
    // answer it led to, which is exactly what users reported.
    const model = await serve(ROLE_FRAME_CHUNKS);
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      gatewayReasoning: true,
    });

    const types = result.parts.map((part) => part.type);
    expect(types.indexOf('reasoning')).toBeLessThan(types.indexOf('text'));

    const text = result.parts.find((part) => part.type === 'text');
    expect((text as { text: string }).text).toBe('Reading the page now.');
    const reasoning = result.parts.filter((part) => part.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0] as { text: string }).text).toBe('我先看一下当前页面。');
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

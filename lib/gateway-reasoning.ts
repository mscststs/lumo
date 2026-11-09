/**
 * Recover thinking that OpenAI-compatible gateways stream in a field the SDK's
 * chat parser drops.
 *
 * `@ai-sdk/openai`'s Chat-Completions parser reads exactly three delta fields:
 * `content`, `tool_calls` and `annotations`. Gateways that speak the same wire
 * shape but stream thinking as `reasoning_content` (DeepSeek, Qwen, GLM, Kimi,
 * MiniMax, most Chinese vendors) or `reasoning` (OpenRouter and friends) are
 * silently discarded: the text never reaches Lumo, while
 * `usage.completion_tokens` still bills every token of it.
 *
 * That is not only a missing thinking block. It also breaks the speed meter,
 * which is where it was noticed: the live value counts *streamed characters*
 * while the settled value counts *billed tokens*, so a step whose output is ¾
 * invisible reads ~100 T/s all the way through and then jumps to ~400 T/s the
 * instant it settles. Restoring the deltas makes both numbers count the same
 * output — and makes the thinking visible.
 *
 * Mechanism: `streamText`'s `include.rawChunks` re-exposes the parsed SSE
 * events as `raw` stream parts, and `experimental_transform` rewrites the ones
 * that carry thinking into the `reasoning-*` parts the rest of Lumo already
 * understands (UI block, prompt sizing, history projection). The raw chunk is
 * dropped when it was consumed — it holds nothing else — and every other part
 * is passed through untouched.
 *
 * Ordering falls out of the wire format: the provider enqueues `raw` before the
 * content delta of the same event, so the reasoning part lands before the text
 * it preceded.
 */

import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

/**
 * Delta fields that carry streamed thinking, in priority order.
 *
 * `reasoning_content` is the de-facto gateway spelling; `reasoning` is what
 * OpenRouter uses. Both are plain strings of the next chunk, not cumulative
 * snapshots.
 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning'] as const;

/**
 * Parts that end the current thinking block.
 *
 * A gateway can stop thinking and start a tool call with no blank line, so the
 * block has to be closed explicitly: the UI groups reasoning by part id, and an
 * open block would absorb whatever came next. Native `reasoning-start` is
 * included so a provider that maps thinking itself cannot merge with ours.
 */
const ENDS_REASONING: ReadonlySet<TextStreamPart<ToolSet>['type']> = new Set([
  'text-start',
  'tool-input-start',
  'reasoning-start',
  'finish-step',
  'finish',
  'error',
  'abort',
]);

/** The reasoning delta inside one raw provider chunk, if it has one. */
export function reasoningTextFromRaw(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { choices } = raw as { choices?: unknown };
  if (!Array.isArray(choices)) return null;

  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue;
    const { delta } = choice as { delta?: unknown };
    if (delta === null || typeof delta !== 'object') continue;
    for (const field of REASONING_FIELDS) {
      const value = (delta as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return null;
}

/**
 * Stream transform that turns gateway thinking deltas into `reasoning` parts.
 *
 * Pairs with `include: { rawChunks: true }`; without raw chunks it is a no-op
 * passthrough, so it is safe to install unconditionally.
 */
export function gatewayReasoningTransform<
  TOOLS extends ToolSet = ToolSet,
>(): StreamTextTransform<TOOLS> {
  return () => {
    /** Id of the thinking block currently open, or null. */
    let openId: string | null = null;
    // One transform instance covers exactly one model call, so a counter keeps
    // ids unique without coordinating with the SDK's own part ids.
    let blocks = 0;

    return new TransformStream<
      TextStreamPart<TOOLS>,
      TextStreamPart<TOOLS>
    >({
      transform(chunk, controller) {
        if (chunk.type === 'raw') {
          const text = reasoningTextFromRaw(chunk.rawValue);
          if (text !== null) {
            if (openId === null) {
              openId = `gateway-reasoning-${blocks++}`;
              controller.enqueue({ type: 'reasoning-start', id: openId });
            }
            controller.enqueue({ type: 'reasoning-delta', id: openId, text });
            // The raw chunk carried this delta and nothing else the SDK uses.
            return;
          }
        } else if (openId !== null && ENDS_REASONING.has(chunk.type)) {
          controller.enqueue({ type: 'reasoning-end', id: openId });
          openId = null;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (openId === null) return;
        controller.enqueue({ type: 'reasoning-end', id: openId });
        openId = null;
      },
    });
  };
}

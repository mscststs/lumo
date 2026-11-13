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
 * it preceded — provided the text part itself is not opened earlier. It is: the
 * parser opens a text part on *any* non-null `delta.content`, and every
 * compatible gateway announces its role with `{"role":"assistant","content":""}`,
 * which is a text part with nothing in it. Released as-is, that part takes index
 * 0 of the message (the parser keeps a single text part per call, so the whole
 * reply later streams into it) and the thinking rewritten here lands *after* the
 * reply it preceded. Hence {@link gatewayReasoningTransform} withholds the text
 * start until the part proves it carries text.
 */

import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

/**
 * A `text-start` / `text-delta` part, narrowed without `Extract`.
 *
 * `Extract<TextStreamPart<TOOLS>, { type: 'text-start' }>` cannot be relied on
 * while `TOOLS` is still generic: the conditional is deferred, and the tool-call
 * arm comes along with it (which has no `id`). Intersecting the part with the
 * fields this transform reads keeps the generic precise and the reads typed.
 */
type TextStart = TextStreamPart<ToolSet> & { type: 'text-start'; id: string };
type TextDelta = TextStreamPart<ToolSet> & { type: 'text-delta'; id: string; text: string };

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
    /**
     * The call's first text part, withheld until it carries text.
     *
     * The parser reuses one text part id for the whole call, so this single
     * deferral is enough: until the reply's first real character arrives there is
     * nothing before the text but framing, and everything framing-shaped (the
     * role announcement's empty delta) must not claim a position ahead of the
     * thinking that is still streaming.
     */
    let heldStart: TextStreamPart<TOOLS> | null = null;
    /** Deltas that arrived while the start above was withheld, replayed on release. */
    let heldDeltas: TextStreamPart<TOOLS>[] = [];
    /** Whether the text part has been handed downstream; after this, pass through. */
    let textReleased = false;

    /** Close the open thinking block, if any. */
    const closeReasoning = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
    ) => {
      if (openId === null) return;
      controller.enqueue({ type: 'reasoning-end', id: openId });
      openId = null;
    };

    /** Drop the withheld start and the deltas that belong to it. */
    const dropHeld = () => {
      heldStart = null;
      heldDeltas = [];
    };

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
          controller.enqueue(chunk);
          return;
        }

        // A second start before the first was proven means the first carried
        // nothing at all; it was never released, so simply forget it.
        if (chunk.type === 'text-start' && !textReleased) {
          heldStart = chunk;
          heldDeltas = [];
          return;
        }

        if (
          heldStart !== null &&
          chunk.type === 'text-delta' &&
          chunk.id === (heldStart as TextStart).id
        ) {
          heldDeltas.push(chunk);
          // An empty delta is framing, not text: keep waiting. Whitespace counts
          // as text on purpose — the parser emits a `"\n"` before a tool call, and
          // that part is real (if invisible) content the transcript always had.
          if ((chunk as TextDelta).text.length === 0) return;
          // The part is real, so the thinking that precedes it is over: close it
          // before the text start takes its place in the message.
          closeReasoning(controller);
          controller.enqueue(heldStart);
          for (const delta of heldDeltas) controller.enqueue(delta);
          textReleased = true;
          dropHeld();
          return;
        }

        if (
          heldStart !== null &&
          chunk.type === 'text-end' &&
          chunk.id === (heldStart as TextStart).id
        ) {
          // Only the empty framing ever landed. Emit nothing rather than hand the
          // transcript a part with no text: the UI would hide it, but it would
          // still hold a position ahead of the thinking it never preceded.
          dropHeld();
          return;
        }

        if (openId !== null && ENDS_REASONING.has(chunk.type)) {
          closeReasoning(controller);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        // A call that was aborted, or that only thought and never answered, can
        // leave the withheld start behind; it was never released, so drop it.
        dropHeld();
        closeReasoning(controller);
      },
    });
  };
}

/**
 * Per-step generation metrics: time to first token (TTFT) and output speed.
 *
 * These are the two numbers a user watches while a reply streams. They are
 * deliberately *per model call*, not per turn: one assistant turn in Lumo is a
 * chain of agent-loop steps, and a turn-level rate would smear a slow reasoning
 * step into a fast tool-formulation step. Measuring each call separately also
 * excludes tool execution structurally — a step is one `streamText` call, so
 * the time the loop spends running tools never lands in a denominator.
 *
 * The arithmetic is `@everyx/pi-status-line`'s (the status-line extension pi is
 * configured with), line for line:
 *
 *   TTFT = generation start → first observed output
 *   TPS  = output tokens / wall clock (firstToken → now, and → message end when
 *          the call settles)
 *
 * - **Numerator** is the *whole* generation: the provider's exact
 *   `usage.output` once the call ends, otherwise one ceil over the cumulative
 *   character count (CJK ≈ 1 token/char, other ≈ 4 chars/token). Never a
 *   per-delta ceil: `Σceil(cᵢ/4)` ≥ `ceil(Σcᵢ/4)` inflates the sum (≈ +40% on
 *   token-aligned streams, +284% on char-level ones).
 * - **Denominator** is wall clock, from the first token to now (live) or to the
 *   end of the call (settled). Gaps between chunks count — a stalled provider is
 *   slow, and hiding that would flatter it. TTFT is excluded and reported on
 *   its own. There is deliberately **no floor** on the window: 321 tokens in
 *   0.43s is 746 T/s, and pi prints exactly that. The only guard on a
 *   sub-second window is the debounce below.
 * - **Debounce**: below {@link LIVE_TPS_DEBOUNCE_MS} the sample is one burst,
 *   not a measurement, so the value is absent — "not measurable yet", not 0.
 * - **Live** is the running average over the generation so far: the final
 *   value's intermediate form. An "instantaneous" per-chunk rate would measure
 *   transport buffering, not the model.
 *
 * Every streamed output counts — text, reasoning, **and tool-call argument
 * deltas** — because pi's `extractDelta` accepts any non-empty
 * `assistantMessageEvent.delta`, and a tool's JSON arguments are exactly that.
 * A tool step whose arguments stream past the debounce therefore has a speed,
 * same as a text step: tool calls are not a special case in the formula.
 *
 * The one place the two sides can still disagree is output the client never
 * sees. The live value can only count characters that arrived; the settled value
 * counts what the provider billed. A gateway that streams thinking in
 * `reasoning_content` used to hide a whole thinking pass from the meter, which
 * read as ~100 T/s during the stream and jumped to ~400 T/s at settlement.
 * `lib/gateway-reasoning.ts` restores those deltas, so both numbers count the
 * same output; what remains is only the char→token estimator's own error.
 *
 * The window ends at the **model-call end**, not at the last delta: pi's
 * `message_end` handler reads the clock there, so a provider that flushes a
 * tool call and then holds the stream open still spent that time generating.
 * Lumo gets that instant from the SDK's `onLanguageModelCallEnd`, which fires
 * before client-side tools run — the agent loop's UI stream only drains after
 * the tools have finished, so reading the clock there would divide the model's
 * tokens by the tool's runtime. An earlier version ended the window at the last
 * observed delta and reported a held-open call as an instant burst.
 *
 * Three intentional differences, all in what is displayed, none in the math:
 *
 * 1. Values are **per step**, so the settled ledger can list every model call;
 *    pi's footer keeps a single session-wide value and averages TTFT over the
 *    session. Lumo therefore shows each call's own TTFT.
 * 2. A metric is **absent** while unmeasurable instead of leaving the previous
 *    segment's number on screen — every Lumo row pairs one call's TTFT with
 *    that same call's speed.
 * 3. TTFT also opens on a tool call that arrives as one complete part, with no
 *    streamed argument delta. pi's `firstTokenMs` can only start on a delta, so
 *    it shows nothing for such a call. A *rate* still needs a decode sample:
 *    the window has to start at a delta, so a whole-call tool step gets TTFT
 *    and no TPS, exactly like pi.
 *
 * This module deliberately does **not** reuse `lib/prompt-size.ts`'s estimator:
 * that one prices a prompt for a context budget (plain chars/4), while this one
 * estimates visible decode output (CJK ≈ 1 token/char). Merging them would
 * silently move compaction thresholds or understate Chinese output speed.
 */

import type { ChatMessagePart, TokenUsageStep } from '@/types';

/** Minimum decode window before a live rate is worth showing. */
export const LIVE_TPS_DEBOUNCE_MS = 250;

/** Minimum gap between live metric emissions (UI refresh budget). */
export const LIVE_METRICS_INTERVAL_MS = 100;

/** Conservative chars-per-token ratio for non-CJK text. */
const CHARS_PER_TOKEN = 4;

/**
 * CJK/Kana/Hangul ranges. These cost roughly one token per character
 * (cl100k/o200k ≈ 1.1–1.6 chars/token), not four — measuring a Chinese reply
 * with the latin ratio would understate its speed by ~3×.
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * Locale-neutral technical abbreviations.
 *
 * Deliberately **not** translation keys: `TTFT` and `T/s` are identical in every
 * language, and the visible metrics row uses icons rather than words. These
 * strings exist only as `title`/accessibility text on those icons, so they stay
 * out of the 55 locale bundles by design — do not route them through `t()`.
 */
export const METRIC_LABELS = {
  ttft: 'TTFT',
  tps: 'T/s',
} as const;

/** A live snapshot of the step currently being generated. */
export interface StepMetrics {
  /** Zero-based agent-loop step index within the turn. */
  step: number;
  /** Milliseconds from request start to the first output chunk. */
  ttftMs: number | null;
  /**
   * Running average of output tokens per second over the call's decode window;
   * `null` before it is measurable.
   */
  tps: number | null;
}

/** Timings persisted on a completed usage step. */
export type StepTiming = Pick<TokenUsageStep, 'ttftMs' | 'decodeMs'>;

/** Monotonic clock for durations; `Date.now()` can jump with system time. */
export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function countCjkChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) count++;
  }
  return count;
}

/** Estimate decode tokens from a full character count — one `ceil`, never per delta. */
export function estimateDecodeTokens(chars: number, cjkChars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(cjkChars + (chars - cjkChars) / CHARS_PER_TOKEN);
}

/** `850ms` / `1.2s` — short enough for a 10px metrics row. */
export function formatTtft(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** `42.1 T/s` — an integer once the rate is large enough for decimals to be noise. */
export function formatTps(tps: number): string {
  if (tps >= 100) return `${tps.toFixed(0)} T/s`;
  return `${tps.toFixed(1)} T/s`;
}

/** Output speed over a decode window; the single formula for live and final. */
export function tokensPerSecond(
  tokens: number,
  decodeMs: number | undefined,
): number | null {
  if (!decodeMs || decodeMs <= 0 || tokens <= 0) return null;
  return tokens / (decodeMs / 1000);
}

/**
 * Final output speed of a completed step, derived from the timings stored on
 * it: the provider's whole output token count over the call's decode window.
 *
 * The debounce still applies below {@link LIVE_TPS_DEBOUNCE_MS}, so a call that
 * ended within one burst has no rate — same rule as the live value and pi's
 * `message_end` path. There is no floor on the window: a short window reports a
 * high rate, because that is what the tokens-per-second arithmetic says.
 */
export function stepThroughput(
  step: Pick<TokenUsageStep, 'outputTokens' | 'decodeMs'>,
): number | null {
  if (!step.decodeMs || step.decodeMs < LIVE_TPS_DEBOUNCE_MS) return null;
  return tokensPerSecond(step.outputTokens, step.decodeMs);
}

/**
 * Incremental character counter for one streaming step.
 *
 * `readUIMessageStream` hands back a freshly built part array on every chunk,
 * so re-scanning the whole reply on each delta would be quadratic (a 20k-char
 * answer arrives as thousands of chunks). The meter remembers how much of each
 * part index was already counted and only looks at the appended tail.
 *
 * Tool parts contribute their streamed JSON arguments (`rawInput`), exactly the
 * characters pi counts as `toolcall_delta`s. A tool call that arrives whole
 * contributes none — the recorder treats its arrival as "output arrived" for
 * TTFT, separately.
 */
export class StepCharMeter {
  totalChars = 0;
  cjkChars = 0;
  private lengths: number[] = [];

  /** Record `parts` and return the number of characters added since last call. */
  add(parts: readonly ChatMessagePart[]): number {
    let added = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const source = textSource(part);
      if (source === null) continue;

      const length = source.length;
      const previous = this.lengths[index] ?? 0;

      if (length > previous) {
        const delta = source.slice(previous);
        added += delta.length;
        this.totalChars += delta.length;
        this.cjkChars += countCjkChars(delta);
        this.lengths[index] = length;
      } else if (length < previous && !isToolPart(part)) {
        // Text/reasoning parts are append-only within a step, so shrinking
        // means the array was rebuilt (e.g. a retry). Rescan from scratch
        // rather than carry a wrong total. Tool parts are different: the SDK
        // drops `rawInput` once the call completes, and the counted argument
        // characters must stay in the total.
        this.reset();
        this.rescan(parts);
        return 0;
      }
    }
    return added;
  }

  reset(): void {
    this.totalChars = 0;
    this.cjkChars = 0;
    this.lengths = [];
  }

  private rescan(parts: readonly ChatMessagePart[]): void {
    for (let index = 0; index < parts.length; index++) {
      const source = textSource(parts[index]!);
      if (source === null) continue;
      this.lengths[index] = source.length;
      if (source.length > 0) {
        this.totalChars += source.length;
        this.cjkChars += countCjkChars(source);
      }
    }
  }
}

/**
 * The countable text of a part.
 *
 * Tool parts expose their streamed JSON as `rawInput` while the call is being
 * built — the same characters pi accumulates as deltas.
 */
function textSource(part: ChatMessagePart): string | null {
  if (part.type === 'text' || part.type === 'reasoning') return part.text;
  if (isToolPart(part)) {
    const rawInput = (part as { rawInput?: string }).rawInput;
    return typeof rawInput === 'string' ? rawInput : null;
  }
  return null;
}

/**
 * Records one step's generation timing and publishes live snapshots.
 *
 * Owns the whole live policy — first-output detection, the debounce, the
 * emission throttle, and the `estimate → exact` transition — so the agent loop
 * stays a loop instead of growing another state machine. `clock` is injectable
 * so the policy is deterministic in tests.
 */
export class StepTimingRecorder {
  private readonly meter = new StepCharMeter();
  private readonly startedAt: number;
  /** First output of any kind — opens the TTFT measurement. */
  private firstOutputAt: number | null = null;
  /** First *delta* — opens the decode window a rate can be derived from. */
  private firstDeltaAt: number | null = null;
  /** Latest delta, and the conservative fallback for the window's end. */
  private lastDeltaAt: number | null = null;
  /** The AI SDK's model-call end — pi's assistant `message_end`. */
  private modelCallEndedAt: number | null = null;
  private lastEmitAt = 0;

  constructor(
    private readonly step: number,
    private readonly emit?: (metrics: StepMetrics) => void,
    private readonly clock: () => number = nowMs,
  ) {
    this.startedAt = clock();
  }

  /**
   * Close the generation window at the model-call end.
   *
   * Wired to the SDK's `onLanguageModelCallEnd`, which fires after the response
   * is parsed and *before* client-side tool execution. That distinction is the
   * whole point: the agent loop only sees the end of its UI stream after the
   * tools have run, so reading the clock there would divide the model's tokens
   * by the tool's duration. pi avoids this by only ending on an assistant
   * `message_end`, never on tool results.
   */
  markModelCallEnd(): void {
    this.modelCallEndedAt = this.clock();
  }

  /** Consume one streamed part snapshot for this step. */
  observe(parts: readonly ChatMessagePart[]): void {
    const added = this.meter.add(parts);
    const now = this.clock();

    if (this.firstOutputAt === null) {
      // pi's `addDelta` opens its clock on a non-empty delta. A tool call that
      // arrives as one complete part never produces one, so it would have no
      // TTFT at all; its arrival is still an output, so TTFT opens here. It is
      // deliberately *not* a decode sample — see `firstDeltaAt`.
      const wholeToolCall = added === 0 && parts.some(isCompleteToolInput);
      if (added === 0 && !wholeToolCall) return;

      this.firstOutputAt = now;
      if (added > 0) {
        this.firstDeltaAt = now;
        this.lastDeltaAt = now;
      }
      this.publish({ ttftMs: Math.round(now - this.startedAt), tps: null });
      this.lastEmitAt = now;
      return;
    }

    if (added > 0) {
      this.firstDeltaAt ??= now;
      this.lastDeltaAt = now;
    }
    if (added > 0 && now - this.lastEmitAt >= LIVE_METRICS_INTERVAL_MS) {
      this.publish({
        ttftMs: Math.round(this.firstOutputAt - this.startedAt),
        tps: this.runningTps(now),
      });
      this.lastEmitAt = now;
    }
  }

  /**
   * Close the step and publish its final values.
   *
   * The window is `first delta → model-call end`, exactly like pi's
   * `firstTokenMs → message_end`. The end is the timestamp taken by
   * {@link markModelCallEnd}; the last delta is only the fallback for a call
   * whose end callback never fired. The numerator is the provider's exact
   * output count when there is one, otherwise the character estimate.
   */
  finish(outputTokens: number): StepTiming {
    const end = this.modelCallEndedAt ?? this.lastDeltaAt;
    const ttftMs =
      this.firstOutputAt !== null ? this.firstOutputAt - this.startedAt : null;
    const decodeMs =
      this.firstDeltaAt !== null && end !== null
        ? Math.round(end - this.firstDeltaAt)
        : null;

    const tokens =
      outputTokens > 0
        ? outputTokens
        : estimateDecodeTokens(this.meter.totalChars, this.meter.cjkChars);
    // Same debounce as the live value and as pi's `message_end` path: a window
    // this short is a single burst, not a rate, so the value is absent rather
    // than astronomically large.
    const tps =
      decodeMs !== null && decodeMs >= LIVE_TPS_DEBOUNCE_MS
        ? tokensPerSecond(tokens, decodeMs)
        : null;

    if (ttftMs !== null || tps !== null) {
      this.publish({
        ttftMs: ttftMs === null ? null : Math.round(ttftMs),
        tps,
      });
    }

    return {
      ...(ttftMs !== null ? { ttftMs: Math.round(ttftMs) } : {}),
      ...(decodeMs !== null && decodeMs > 0 ? { decodeMs } : {}),
    };
  }

  /**
   * Running-average speed over the generation so far: the same formula as the
   * settled value, with `now` standing in for the call's end.
   */
  private runningTps(now: number): number | null {
    if (this.firstDeltaAt === null) return null;
    const elapsed = now - this.firstDeltaAt;
    if (elapsed < LIVE_TPS_DEBOUNCE_MS) return null;
    return tokensPerSecond(
      estimateDecodeTokens(this.meter.totalChars, this.meter.cjkChars),
      elapsed,
    );
  }

  private publish(values: Pick<StepMetrics, 'ttftMs' | 'tps'>): void {
    this.emit?.({ step: this.step, ...values });
  }
}

/** Whether a UI part is a tool part (static `tool-${name}` or `dynamic-tool`). */
function isToolPart(part: ChatMessagePart): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

/**
 * A tool call whose arguments arrived whole — no streamed argument delta.
 *
 * `rawInput` is only present while the arguments are streaming, so a part that
 * reached `input-available` without it never contributed characters to the
 * meter. Its arrival still counts as the first output (for TTFT), because pi's
 * format would otherwise show nothing at all for that call.
 */
function isCompleteToolInput(part: ChatMessagePart): boolean {
  if (!isToolPart(part)) return false;
  const tool = part as { state?: string; input?: unknown; rawInput?: unknown };
  return (
    tool.state === 'input-available' &&
    tool.input !== undefined &&
    typeof tool.rawInput !== 'string'
  );
}

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
 *   TTFT = request start → first observed output
 *   TPS  = output tokens / wall clock (request start → now, and → call end once
 *          the call settles)
 *
 * - **Numerator** is the *whole* generation: the provider's exact
 *   `usage.output` once the call ends, otherwise one ceil over the cumulative
 *   character count (CJK ≈ 1 token/char, other ≈ 4 chars/token). Never a
 *   per-delta ceil: `Σceil(cᵢ/4)` ≥ `ceil(Σcᵢ/4)` inflates the sum (≈ +40% on
 *   token-aligned streams, +284% on char-level ones).
 * - **Denominator is the whole call, TTFT included.** Lumo used to copy pi's
 *   status line line for line and open the rate at the first delta. That reads
 *   a transport artifact as model speed: a provider or gateway that holds the
 *   stream for three seconds and then flushes five thousand tokens in a single
 *   chunk measured as thousands of T/s, even though no one ever received those
 *   tokens at that pace. Total output over total wait — first token and
 *   streaming together — is the average the user actually lived through: a slow
 *   first token can only pull it down, and a long reply amortises it away.
 *   Gaps between chunks count too — a stalled provider is slow, and hiding that
 *   would flatter it. There is deliberately **no floor** on the window, only
 *   the debounce below: a call that really produced 321 tokens in 0.43s from
 *   the request onward reads 746 T/s, and that is the truth about that call.
 * - **Debounce**: below {@link RATE_MIN_WINDOW_MS} the whole call is one
 *   burst, not a measurement, so the value is absent — "not measurable yet",
 *   not 0.
 * - **Live** is the running average over the call so far — the same window,
 *   `request start → now` — and the final value's intermediate form. An
 *   "instantaneous" per-chunk rate would measure transport buffering, not the
 *   model.
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
 * Beyond that denominator, three intentional differences from pi, all of them
 * in what is displayed:
 *
 * 1. Values are **per step**, so the settled ledger can list every model call;
 *    pi's footer keeps a single session-wide value and averages TTFT over the
 *    session. Lumo therefore shows each call's own TTFT.
 * 2. A metric is **absent** while unmeasurable instead of leaving the previous
 *    segment's number on screen — every Lumo row pairs one call's TTFT with
 *    that same call's speed.
 * 3. TTFT also opens on a tool call that arrives as one complete part, with no
 *    streamed argument delta. pi's `firstTokenMs` can only start on a delta, so
 *    it shows nothing for such a call. Lumo reports its TTFT, and — once the
 *    call settles — its rate like any other call: the window is the whole call,
 *    so nothing about the measurement depends on how the output arrived.
 *
 * This module deliberately does **not** reuse `lib/prompt-size.ts`'s estimator:
 * that one prices a prompt for a context budget (plain chars/4), while this one
 * estimates visible decode output (CJK ≈ 1 token/char). Merging them would
 * silently move compaction thresholds or understate Chinese output speed.
 */

import type { ChatMessagePart, TokenUsageStep } from '@/types';

/** Minimum generation window before a rate is worth showing. */
export const RATE_MIN_WINDOW_MS = 250;

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
   * Running average of output tokens per second over the call so far, from the
   * request start (TTFT included); `null` before it is measurable.
   */
  tps: number | null;
}

/** Timings persisted on a completed usage step. */
export type StepTiming = Pick<TokenUsageStep, 'ttftMs' | 'generationMs'>;

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

/** Output speed over a generation window; the single formula for live and final. */
export function tokensPerSecond(
  tokens: number,
  windowMs: number | undefined,
): number | null {
  if (!windowMs || windowMs <= 0 || tokens <= 0) return null;
  return tokens / (windowMs / 1000);
}

/**
 * The window a rate may be derived from, or `undefined` when the call is one
 * burst. The single statement of the debounce policy: the live value, the
 * settled value and the ledger all read it here.
 */
function rateWindow(windowMs: number | null | undefined): number | undefined {
  return windowMs != null && windowMs >= RATE_MIN_WINDOW_MS
    ? windowMs
    : undefined;
}

/**
 * Final output speed of a completed step, derived from the timings stored on
 * it: the provider's whole output token count over the whole call, TTFT
 * included.
 *
 * There is no floor on the window beyond {@link rateWindow}'s debounce: a short
 * window reports a high rate, because that is what the tokens-per-second
 * arithmetic says.
 */
export function stepThroughput(
  step: Pick<TokenUsageStep, 'outputTokens' | 'generationMs'>,
): number | null {
  return tokensPerSecond(step.outputTokens, rateWindow(step.generationMs));
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
      // A tool call that arrives as one complete part never produces a delta,
      // so a delta-only clock would show no TTFT at all. Its arrival is still
      // an output, so TTFT opens here.
      const wholeToolCall = added === 0 && parts.some(isCompleteToolInput);
      if (added === 0 && !wholeToolCall) return;

      this.firstOutputAt = now;
      if (added > 0) this.lastDeltaAt = now;
      // The first sample already carries the running average: its window is the
      // TTFT just spent, so a burst that lands here is divided by the wait that
      // preceded it. A whole tool call contributes no characters to estimate
      // from, so `runningTps` returns null for it without a special case.
      this.publish({
        ttftMs: Math.round(now - this.startedAt),
        tps: this.runningTps(now),
      });
      this.lastEmitAt = now;
      return;
    }

    if (added === 0) return;
    this.lastDeltaAt = now;
    if (now - this.lastEmitAt < LIVE_METRICS_INTERVAL_MS) return;

    this.publish({
      ttftMs: Math.round(this.firstOutputAt - this.startedAt),
      tps: this.runningTps(now),
    });
    this.lastEmitAt = now;
  }

  /**
   * Close the step and publish its final values.
   *
   * The rate's window is the whole call: the recorder's start (before the
   * request goes out) → the model-call end. TTFT is therefore part of the
   * denominator, not an excluded prologue. The end is the timestamp taken by
   * {@link markModelCallEnd}; the last delta is only the fallback for a call
   * whose end callback never fired. The numerator is the provider's exact
   * output count when there is one, otherwise the character estimate.
   *
   * How the output arrived does not enter the arithmetic: a call whose
   * arguments landed in one part has the same window as one that streamed every
   * delta.
   */
  finish(outputTokens: number): StepTiming {
    const end = this.modelCallEndedAt ?? this.lastDeltaAt;
    const ttftMs =
      this.firstOutputAt !== null
        ? Math.round(this.firstOutputAt - this.startedAt)
        : null;
    const generationMs = end !== null ? Math.round(end - this.startedAt) : null;

    const tokens =
      outputTokens > 0
        ? outputTokens
        : estimateDecodeTokens(this.meter.totalChars, this.meter.cjkChars);
    const tps = tokensPerSecond(tokens, rateWindow(generationMs));

    if (ttftMs !== null || tps !== null) this.publish({ ttftMs, tps });

    return {
      ...(ttftMs !== null ? { ttftMs } : {}),
      ...(generationMs !== null && generationMs > 0 ? { generationMs } : {}),
    };
  }

  /**
   * Running-average speed over the call so far: the same formula as the settled
   * value with `now` standing in for the call's end, so the window starts at
   * the request and includes whatever TTFT has been spent.
   */
  private runningTps(now: number): number | null {
    return tokensPerSecond(
      estimateDecodeTokens(this.meter.totalChars, this.meter.cjkChars),
      rateWindow(now - this.startedAt),
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
 * meter — and left no delta to read the clock from. Its arrival still counts as
 * the first output, so such a call gets a TTFT like any other.
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

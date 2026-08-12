import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';

/**
 * Deterministic recovery of malformed tool-call arguments.
 *
 * The AI SDK parses a tool call's `input` with `JSON.parse` and has exactly one
 * tolerance built in: an input that is *entirely* empty is read as `{}`
 * (`doParseToolCall`). Anything else that is not valid JSON — or is valid JSON
 * that is not an object — becomes an `InvalidToolInputError`, which the SDK turns
 * into a `tool-error` part. That costs a whole loop step, burns a slot from the
 * user's step cap, and leaves a red failure in the transcript, all for a call the
 * model meant correctly.
 *
 * The failures worth catching here are transport-shaped, not reasoning-shaped:
 *
 * - `{}""` — the streaming assembler concatenates every `function.arguments`
 *   delta unconditionally (`StreamingToolCallTracker`), so a gateway that emits
 *   one spurious extra fragment produces two concatenated JSON values.
 * - `null` / `undefined` — some gateways spell "no arguments" as a literal
 *   instead of as the empty string the SDK already tolerates.
 * - `"{\"a\":1}"` — a JSON object encoded twice on its way through a proxy.
 * - ```` ```json … ``` ```` — a model that formatted its arguments as prose.
 *   Falls out of the leading-object scan rather than needing its own rule.
 *
 * Zero-parameter tools hit this hardest: with `properties: {}` there is nothing
 * to generate, which is exactly the situation that produces degenerate output.
 *
 * Every strategy below is a pure string transform. Nothing here re-asks the
 * model: a second model call would add latency and cost to a fault that is
 * mechanically decidable, and would still be a guess. When no strategy applies
 * the repair declines, and the original error surfaces unchanged — silently
 * inventing arguments for a call whose arguments were genuinely wrong would trade
 * a visible failure for a wrong action.
 */

/** The repaired input for a call that takes no arguments. */
const EMPTY_INPUT = '{}';

/**
 * Literal spellings of "no arguments" that are not valid JSON objects.
 *
 * The empty string is absent on purpose: the SDK already reads it as `{}`, so a
 * tool call carrying it never reaches a repair.
 */
const NO_ARGUMENTS = new Set(['null', 'undefined']);

/**
 * How many times an input may be unwrapped from an enclosing JSON string.
 *
 * This is a limit on plausibility, not on work: every encoding layer roughly
 * doubles the text, so the number of layers an input of a given size can carry is
 * already logarithmic in its length. One layer is the observed fault — a proxy
 * re-encoding a body it treated as a string. Past a couple of layers the input is
 * no longer a re-encoded object that something mangled in transit, so unwrapping
 * further would be reading structure into noise.
 */
const MAX_UNWRAP_DEPTH = 3;

/**
 * Whether a schema describes a call that takes no arguments at all.
 *
 * Both `properties` and `required` must be empty: a schema with optional
 * properties still has arguments the model could legitimately be sending, and
 * discarding them would silently change what the tool does.
 *
 * `type` is allowed to be absent because a hand-written JSON Schema — which is
 * how WebMCP pages and external MCP servers describe their tools — often omits
 * it while still describing an object.
 */
export function takesNoInput(schema: JSONSchema7): boolean {
  if (schema.type != null && schema.type !== 'object') return false;
  const properties = schema.properties;
  if (properties != null && Object.keys(properties).length > 0) return false;
  return schema.required == null || schema.required.length === 0;
}

/**
 * Whether a recovered object still carries every property the schema demands.
 *
 * A recovery that drops a required property is worse than no recovery: the SDK
 * would reject it a second time, and the error the user sees would describe the
 * repaired input rather than what the model actually sent. Declining instead
 * keeps the original diagnostic intact.
 */
function hasRequiredKeys(value: Record<string, unknown>, schema: JSONSchema7): boolean {
  const required = schema.required;
  if (required == null) return true;
  return required.every((key) => key in value);
}

/** Parse `text`, returning it only if it is a plain JSON object. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse `text`, returning it only if it is a JSON string. */
function parseString(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Extract the first complete JSON object from `text`, ignoring whatever follows.
 *
 * This is what recovers `{}""` and `{"a":1}{"a":1}`: the leading value is the
 * one the model produced, and the remainder is the transport's fault. The scan
 * tracks string and escape state so a brace inside a string value — `{"a":"}"}`
 * — does not close the object early.
 *
 * Only objects are scanned for. A tool input is always an object, so recovering
 * an array or a bare scalar would produce something the schema must reject
 * anyway.
 */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }

  // Unbalanced: the object was truncated, so there is no complete value to take.
  return null;
}

/**
 * Recover the object a malformed input was meant to be, or `null`.
 *
 * Ordered cheapest-and-most-certain first, so a fault that has an exact reading
 * is never resolved by a broader guess.
 */
function recoverObject(raw: string, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;

  const text = raw.trim();

  if (text.length === 0 || NO_ARGUMENTS.has(text.toLowerCase())) return {};

  // A well-formed object reached this point only because the *schema* rejected
  // it, which is a reasoning fault no string transform can fix.
  const direct = parseObject(text);
  if (direct != null) return direct;

  // Encoded one layer too many; unwrap and re-run every strategy on the payload.
  const unwrapped = parseString(text);
  if (unwrapped != null) return recoverObject(unwrapped, depth + 1);

  // Last: take the leading object out of whatever surrounds it. This is what
  // recovers concatenated fragments, and it subsumes prose wrappers such as a
  // markdown fence for free, since a fence is just text on either side of the
  // object — no separate unfencing step is needed.
  const prefix = firstJsonObject(text);
  return prefix != null ? parseObject(prefix) : null;
}

/**
 * Repair a tool call's raw `input`, or return `null` to keep the original error.
 *
 * Returns a JSON string because that is the wire shape of `input` throughout the
 * SDK; the caller hands it straight back for re-parsing.
 */
export function repairToolInput({
  input,
  schema,
}: {
  input: string;
  schema: JSONSchema7;
}): string | null {
  // Valid JSON object, rejected by the schema: the values are wrong, not the
  // encoding. The one exception is a tool that takes no arguments, where `{}` is
  // the only input it can ever have.
  if (parseObject(input) != null) {
    return takesNoInput(schema) ? EMPTY_INPUT : null;
  }

  const recovered = recoverObject(input);
  if (recovered != null && hasRequiredKeys(recovered, schema)) {
    return JSON.stringify(recovered);
  }

  // Nothing readable came out, but a tool with no parameters has only one
  // possible input, so the call can still be honoured as the model intended.
  return takesNoInput(schema) ? EMPTY_INPUT : null;
}

/**
 * `streamText`'s `repairToolCall` hook, wired to the transforms above.
 *
 * Declines for `NoSuchToolError`: a name the tool set does not contain is not a
 * malformed-argument problem, and there is no schema to repair against.
 */
export const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({
  toolCall,
  error,
  inputSchema,
}) => {
  if (NoSuchToolError.isInstance(error)) return null;

  const schema = await inputSchema({ toolName: toolCall.toolName });
  const input = repairToolInput({ input: toolCall.input, schema });

  return input == null ? null : { ...toolCall, input };
};

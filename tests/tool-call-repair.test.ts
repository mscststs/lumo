/**
 * Tool-call argument repair.
 *
 * The bug this guards against: a gateway emitted `{}""` as the arguments of the
 * zero-parameter `browser_get_active_tab`, the SDK failed to `JSON.parse` it, and
 * the call surfaced as a red `output-error` in the transcript — spending a loop
 * step and a slot from the user's step cap on a call the model meant correctly.
 *
 * Two halves, and the second is the important one: repairing malformed input is
 * easy, and *declining* to repair input that is merely wrong is what keeps a real
 * fault visible instead of turning it into a silently wrong action.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { tool, isToolUIPart, InvalidToolInputError, NoSuchToolError } from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { z } from 'zod';
import type { ChatMessagePart } from '@/types';
import { runAgentLoop } from '@/lib/ai';
import {
  firstJsonObject,
  repairToolCall,
  repairToolInput,
  takesNoInput,
} from '@/lib/tool-call-repair';

/** What `z.object({})` becomes on the wire, `additionalProperties` and all. */
const NO_ARGS: JSONSchema7 = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** A schema with one required property, to test declining. */
const REQUIRED_ARG: JSONSchema7 = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};

/** A schema whose every property is optional. */
const OPTIONAL_ARG: JSONSchema7 = {
  type: 'object',
  properties: { value: { type: 'string' } },
  additionalProperties: false,
};

describe('takesNoInput', () => {
  it('recognises the empty object schema every zero-arg tool compiles to', () => {
    expect(takesNoInput(NO_ARGS)).toBe(true);
  });

  it('accepts a hand-written schema that omits `type`', () => {
    // WebMCP pages and external MCP servers describe their tools by hand and
    // routinely leave `type` off, so requiring it would exclude exactly the
    // tools this project does not control.
    expect(takesNoInput({ properties: {} })).toBe(true);
    expect(takesNoInput({})).toBe(true);
  });

  it('rejects a schema with optional properties', () => {
    // The model may legitimately be sending them, and discarding them would
    // silently change what the tool does.
    expect(takesNoInput(OPTIONAL_ARG)).toBe(false);
  });

  it('rejects a schema with required properties', () => {
    expect(takesNoInput(REQUIRED_ARG)).toBe(false);
  });

  it('rejects a schema that lists `required` without declaring `properties`', () => {
    // `properties` alone would already reject `REQUIRED_ARG`, so only this shape
    // — legal JSON Schema, and what a hand-written MCP tool definition can look
    // like — actually exercises the `required` check. Reading it as zero-arg
    // would let a call be "repaired" to `{}` and executed without its argument.
    expect(takesNoInput({ type: 'object', required: ['value'] })).toBe(false);
    expect(takesNoInput({ type: 'object', properties: {}, required: ['value'] })).toBe(false);
  });

  it('rejects a non-object schema', () => {
    expect(takesNoInput({ type: 'string' })).toBe(false);
  });
});

describe('firstJsonObject', () => {
  it('takes the leading object and drops trailing junk', () => {
    // The reported fault: two concatenated values, because the streaming
    // assembler appends every `arguments` delta unconditionally.
    expect(firstJsonObject('{}""')).toBe('{}');
    expect(firstJsonObject('{"a":1}{"a":1}')).toBe('{"a":1}');
    expect(firstJsonObject('{"a":1}\n\ntrailing')).toBe('{"a":1}');
  });

  it('does not close the object on a brace inside a string', () => {
    expect(firstJsonObject('{"a":"}"}')).toBe('{"a":"}"}');
    expect(firstJsonObject('{"a":"{"}x')).toBe('{"a":"{"}');
  });

  it('does not close the object on an escaped quote', () => {
    expect(firstJsonObject('{"a":"\\""}x')).toBe('{"a":"\\""}');
    // A trailing backslash inside the string must not end the string either.
    expect(firstJsonObject('{"a":"c:\\\\"}x')).toBe('{"a":"c:\\\\"}');
  });

  it('handles nesting', () => {
    expect(firstJsonObject('{"a":{"b":{"c":1}}}rest')).toBe('{"a":{"b":{"c":1}}}');
  });

  it('declines a truncated object rather than inventing a closing brace', () => {
    // A cut-off object has lost content; guessing at the remainder would make
    // up arguments the model never sent.
    expect(firstJsonObject('{"a":1')).toBeNull();
    expect(firstJsonObject('{"a":{"b":1}')).toBeNull();
  });

  it('declines when there is no object at all', () => {
    expect(firstJsonObject('')).toBeNull();
    expect(firstJsonObject('[1,2]')).toBeNull();
    expect(firstJsonObject('"just a string"')).toBeNull();
  });
});

describe('repairToolInput', () => {
  it('repairs the reported failure', () => {
    expect(repairToolInput({ input: '{}""', schema: NO_ARGS })).toBe('{}');
  });

  it('repairs concatenated fragments for a tool that does take arguments', () => {
    // The transport fault is independent of the schema, so the fix must be too.
    expect(repairToolInput({ input: '{"value":"x"}{"value":"x"}', schema: REQUIRED_ARG })).toBe(
      '{"value":"x"}',
    );
  });

  it('reads a literal null or undefined as "no arguments"', () => {
    // Asserted against a schema with an *optional* property, not `NO_ARGS`: a
    // zero-arg schema falls back to `{}` for unrecoverable input too, so it
    // cannot distinguish "recognised the literal" from "gave up".
    for (const input of ['null', 'undefined', 'NULL', 'Undefined', '  null  ']) {
      expect(repairToolInput({ input, schema: OPTIONAL_ARG })).toBe('{}');
    }
  });

  it('unwraps input that was JSON-encoded one layer too many', () => {
    expect(repairToolInput({ input: '"{\\"value\\":\\"x\\"}"', schema: REQUIRED_ARG })).toBe(
      '{"value":"x"}',
    );
  });

  it('recovers arguments the model wrapped in prose or a markdown fence', () => {
    // No dedicated unfencing rule: the leading-object scan already ignores
    // whatever surrounds the object, so these are the same case as trailing junk.
    expect(
      repairToolInput({ input: '```json\n{"value":"x"}\n```', schema: REQUIRED_ARG }),
    ).toBe('{"value":"x"}');
    expect(
      repairToolInput({ input: 'Here are the arguments: {"value":"x"}', schema: REQUIRED_ARG }),
    ).toBe('{"value":"x"}');
    // Against `OPTIONAL_ARG`, so a `{}` result proves the fence was seen through
    // rather than that a zero-arg schema fell back to `{}`.
    expect(repairToolInput({ input: '```\n{}\n```', schema: OPTIONAL_ARG })).toBe('{}');
  });

  it('falls back to {} for a zero-arg tool when nothing is recoverable', () => {
    // A tool with no parameters has exactly one possible input, so whatever the
    // model emitted, the call it intended is unambiguous.
    for (const input of ['garbage', '[1,2]', '{"a":1', '???']) {
      expect(repairToolInput({ input, schema: NO_ARGS })).toBe('{}');
    }
  });

  describe('declining', () => {
    it('declines a well-formed object the schema rejected', () => {
      // Valid JSON that failed validation is a reasoning fault: the values are
      // wrong, not the encoding. No string transform can fix it, and pretending
      // otherwise would hide the real error.
      expect(repairToolInput({ input: '{"value":42}', schema: REQUIRED_ARG })).toBeNull();
      expect(repairToolInput({ input: '{}', schema: REQUIRED_ARG })).toBeNull();
    });

    it('declines when recovery would drop a required property', () => {
      // The SDK would reject the repaired input a second time, and the error the
      // user finally sees would describe our guess rather than what the model
      // sent.
      expect(repairToolInput({ input: '{"other":1}""', schema: REQUIRED_ARG })).toBeNull();
    });

    it('declines unrecoverable input for a tool that takes arguments', () => {
      for (const schema of [REQUIRED_ARG, OPTIONAL_ARG]) {
        expect(repairToolInput({ input: 'total garbage', schema })).toBeNull();
        expect(repairToolInput({ input: '{"value":"x"', schema })).toBeNull();
      }
    });

    it('declines an array, which no tool input can ever be', () => {
      // A tool input is always an object, so an array must not be handed back as
      // one: the schema would reject it and one error would become another.
      // A bare `[1,2]` never even reaches the object check — the leading-object
      // scan finds no brace — so the case that actually exercises it is an array
      // that arrived encoded, and one wrapping a usable object.
      expect(repairToolInput({ input: '[1,2]', schema: OPTIONAL_ARG })).toBeNull();
      expect(repairToolInput({ input: '"[1,2]"', schema: OPTIONAL_ARG })).toBeNull();
      // The object inside is the recovery, not the array around it.
      expect(repairToolInput({ input: '[{"value":"x"}]', schema: REQUIRED_ARG })).toBe(
        '{"value":"x"}',
      );
    });

    it('does not read a literal null as {} for a tool with required arguments', () => {
      // `{}` is a valid recovery of "no arguments", but it is not a valid call:
      // the tool cannot run without `value`, and inventing a run would be worse
      // than reporting the failure.
      expect(repairToolInput({ input: 'null', schema: REQUIRED_ARG })).toBeNull();
    });

    it('declines input whose only recoverable form omits a `required` key with no `properties`', () => {
      // End-to-end this shape cannot arise from a zod tool, so the unit is the
      // only place the guard is observable.
      expect(
        repairToolInput({ input: 'null', schema: { type: 'object', required: ['value'] } }),
      ).toBeNull();
    });

    it('normalises a zero-arg call to {} rather than passing junk keys through', () => {
      // The schema strips unknown keys anyway, so `{}` is what the tool would
      // receive; sending it explicitly keeps the recorded input honest.
      expect(repairToolInput({ input: '{"stray":1}', schema: NO_ARGS })).toBe('{}');
    });

    it('unwraps a plausible number of encoding layers and then stops', () => {
      // The bound is on plausibility: one layer is the observed proxy fault, and
      // past a couple the input is no longer a mangled object but noise that
      // happens to parse. Asserted from both sides so the limit cannot silently
      // become "unbounded" — which would make how much work an input costs a
      // function of the input itself.
      const layer = (times: number) => {
        let nested = '{}';
        for (let i = 0; i < times; i++) nested = JSON.stringify(nested);
        return repairToolInput({ input: nested, schema: OPTIONAL_ARG });
      };

      expect(layer(1)).toBe('{}');
      expect(layer(3)).toBe('{}');
      expect(layer(4)).toBeNull();
      // Well past the bound. Note how few layers it takes to get there: 16 of
      // them is already a megabyte of escapes, which is the doubling that makes
      // the depth limit a statement about plausibility rather than about cost.
      expect(layer(16)).toBeNull();
    });
  });
});

describe('repairToolCall hook', () => {
  const toolCall = {
    type: 'tool-call' as const,
    toolCallId: 'c1',
    toolName: 'browser_get_active_tab',
    input: '{}""',
  };
  const args = { messages: [], instructions: undefined, system: undefined, tools: {} };

  it('hands back the original call with only `input` replaced', () => {
    // Everything else on a tool call is identity the SDK correlates results by;
    // rebuilding it from scratch would be a place to lose the id.
    return expect(
      repairToolCall({
        ...args,
        toolCall,
        error: new InvalidToolInputError({
          toolName: toolCall.toolName,
          toolInput: toolCall.input,
          cause: new SyntaxError('Unexpected non-whitespace character after JSON'),
        }),
        inputSchema: async () => NO_ARGS,
      }),
    ).resolves.toEqual({ ...toolCall, input: '{}' });
  });

  it('declines a NoSuchToolError without asking for a schema', () => {
    // `asSchema(undefined)` yields an empty-object schema, so an unknown tool
    // would otherwise be "repaired" against a schema that does not exist —
    // reporting a repair for a call that can never run. The SDK re-raises
    // NoSuchToolError either way, which is why this is only visible here.
    const inputSchema = vi.fn();

    return expect(
      repairToolCall({
        ...args,
        toolCall: { ...toolCall, toolName: 'no_such_tool' },
        error: new NoSuchToolError({ toolName: 'no_such_tool' }),
        inputSchema: inputSchema as never,
      }),
    )
      .resolves.toBeNull()
      .then(() => {
        expect(inputSchema).not.toHaveBeenCalled();
      });
  });

  it('declines when the input is not repairable', () => {
    return expect(
      repairToolCall({
        ...args,
        toolCall: { ...toolCall, toolName: 'echo', input: '{"value":42}' },
        error: new InvalidToolInputError({
          toolName: 'echo',
          toolInput: '{"value":42}',
          cause: new Error('value must be a string'),
        }),
        inputSchema: async () => REQUIRED_ARG,
      }),
    ).resolves.toBeNull();
  });
});

// --- End-to-end through the agent loop -------------------------------------

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} satisfies LanguageModelV4Usage;

const TOOL_FINISH = {
  type: 'finish',
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

const FINISH = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

/** Mirrors `browser_get_active_tab`: no parameters at all. */
const activeTabTool = tool({
  description: 'Get information about the currently active tab.',
  inputSchema: z.object({}),
  execute: async () => ({ url: 'https://example.test/' }),
});

/** A tool that genuinely needs an argument, to prove declining still declines. */
const echoTool = tool({
  description: 'Echoes its input back.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ echoed: value }),
});

/**
 * A model that issues one tool call with the given raw `input`, then answers.
 *
 * `input` is passed as the provider would deliver it — a raw string — which is
 * the only way to exercise the SDK's parse-and-repair path.
 */
function callingModel(toolName: string, input: string) {
  const callStep: LanguageModelV4StreamPart[] = [
    { type: 'tool-call', toolCallId: 'c1', toolName, input },
    TOOL_FINISH,
  ];
  const answerStep: LanguageModelV4StreamPart[] = [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'done' },
    { type: 'text-end', id: '0' },
    FINISH,
  ];

  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: call++ === 0 ? callStep : answerStep,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

/** The single tool part of a finished run. */
function toolPart(parts: ChatMessagePart[]) {
  const part = parts.find((p) => isToolUIPart(p));
  expect(part, 'expected a tool part').toBeDefined();
  return part as Extract<ChatMessagePart, { state: string }> & {
    output?: unknown;
    errorText?: string;
  };
}

describe('agent loop with malformed tool arguments', () => {
  it('executes a zero-arg tool whose arguments arrived as `{}""`', async () => {
    const { parts, stoppedReason } = await runAgentLoop({
      model: callingModel('browser_get_active_tab', '{}""'),
      tools: { browser_get_active_tab: activeTabTool },
      messages: [{ role: 'user', content: 'which tab?' }],
    });

    const part = toolPart(parts);
    // The regression: this used to be `output-error` carrying an
    // AI_InvalidToolInputError, wasting a step and showing a red failure.
    expect(part.state).toBe('output-available');
    expect(JSON.stringify(part.output)).toContain('https://example.test/');
    expect(stoppedReason).toBe('finished');
  });

  it('executes a tool whose arguments arrived doubly-encoded', async () => {
    const { parts } = await runAgentLoop({
      model: callingModel('echo', '"{\\"value\\":\\"hi\\"}"'),
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
    });

    const part = toolPart(parts);
    expect(part.state).toBe('output-available');
    expect(JSON.stringify(part.output)).toContain('hi');
  });

  it('still reports a genuinely wrong call as an error', async () => {
    // Over-repairing is the failure mode to fear: a call whose arguments are
    // wrong must stay visible rather than being executed with invented values.
    const { parts } = await runAgentLoop({
      model: callingModel('echo', '{"value":42}'),
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
    });

    const part = toolPart(parts);
    expect(part.state).toBe('output-error');
    expect(part.errorText).toContain('Invalid input');
  });

  it('still reports an unrecoverable call for a tool that needs arguments', async () => {
    const { parts } = await runAgentLoop({
      model: callingModel('echo', 'not json at all'),
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
    });

    expect(toolPart(parts).state).toBe('output-error');
  });

  it('still reports a call to a tool that does not exist', async () => {
    // A wrong *name* is not a malformed-argument problem, and there is no schema
    // to repair against — so the repair must decline and let the SDK say so.
    const { parts } = await runAgentLoop({
      model: callingModel('no_such_tool', '{}'),
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
    });

    const part = toolPart(parts);
    expect(part.state).toBe('output-error');
    expect(part.errorText).toMatch(/no_such_tool/);
  });
});

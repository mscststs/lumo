/**
 * `page_evaluate`'s two execution paths must accept the same `code`.
 *
 * `chrome.scripting` compiles the code as an `AsyncFunction` body, so top-level
 * `return` and `await` are legal — exactly what the tool's description promises.
 * CDP's `Runtime.evaluate` runs a *script*, where a top-level `return` is a hard
 * `SyntaxError: Illegal return statement`. Code written against the documented
 * contract used to break the instant CSP forced the fallback, which is the bug
 * these tests pin down.
 */

import { describe, expect, it } from 'vitest';
import { wrapCodeForCdp } from '@/lib/mcp/page-interact-server';

/** Compile-only check: does the wrapped form parse as a script? */
function isSyntaxValid(wrapped: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function(wrapped);
    return true;
  } catch {
    return false;
  }
}

/** Run the wrapped form and await its result, mirroring `awaitPromise: true`. */
async function evaluate(code: string): Promise<unknown> {
  // eslint-disable-next-line no-new-func
  return await new Function(`return ${wrapCodeForCdp(code)}`)();
}

describe('wrapCodeForCdp: statement bodies', () => {
  it('accepts the top-level return that broke the CSP fallback', () => {
    // Verbatim shape of the reported failure: a `forEach` with an inner
    // `return`, then a top-level `return` of the collected result.
    const code =
      "const out=[];document.querySelectorAll('a.iusc').forEach((a,i)=>{if(i>14)return;out.push(i)});return {count:out.length,out};";
    expect(isSyntaxValid(wrapCodeForCdp(code))).toBe(true);
  });

  it('rejects nothing that the scripting path would have accepted', () => {
    const statements = [
      'return 42',
      'let x = 5; return x;',
      'const a = 1; const b = 2; return a + b;',
      'if (true) { return "yes"; } return "no";',
      'for (const x of [1,2]) { if (x === 2) return x; }',
      'try { return JSON.parse("{}"); } catch (e) { return null; }',
    ];
    for (const code of statements) {
      expect(isSyntaxValid(wrapCodeForCdp(code)), code).toBe(true);
    }
  });

  it('returns the value produced by an explicit return', async () => {
    await expect(evaluate('const a = 2; return a * 21;')).resolves.toBe(42);
  });
});

describe('wrapCodeForCdp: expression bodies', () => {
  it('yields an expression value without an explicit return', async () => {
    // The scripting path gives expressions this precedence, so results must not
    // silently become undefined just because the transport changed.
    await expect(evaluate('1 + 1')).resolves.toBe(2);
    await expect(evaluate('({ a: 1 })')).resolves.toEqual({ a: 1 });
    await expect(evaluate('[1, 2, 3].map((n) => n * 2)')).resolves.toEqual([2, 4, 6]);
  });

  it('still yields a value when a trailing semicolon is present', async () => {
    // Mirrors the scripting path's semicolon-stripping retry; without it this
    // falls through to statement mode and evaluates to undefined.
    await expect(evaluate('1 + 1;')).resolves.toBe(2);
  });

  it('supports top-level await, which the async wrapper is there to preserve', async () => {
    await expect(evaluate('await Promise.resolve("done")')).resolves.toBe('done');
  });

  it('does not mistake string or property contents for statement keywords', async () => {
    // Naive keyword scanning would classify these as statements and wrap them
    // as a body with no `return`, quietly yielding undefined.
    await expect(evaluate('"return"')).resolves.toBe('return');
    await expect(evaluate('({ const: 1 }).const')).resolves.toBe(1);
    await expect(evaluate('"a;b".split(";")')).resolves.toEqual(['a', 'b']);
  });

  it('treats an IIFE containing statements as an expression', async () => {
    await expect(evaluate('(() => { const a = 1; return a + 1; })()')).resolves.toBe(2);
  });
});

describe('wrapCodeForCdp: error surfacing', () => {
  it('lets a genuine syntax error stay a syntax error', () => {
    expect(isSyntaxValid(wrapCodeForCdp('const = ;'))).toBe(false);
  });

  it('propagates runtime exceptions to the caller', async () => {
    await expect(evaluate('throw new Error("boom")')).rejects.toThrow('boom');
  });
});

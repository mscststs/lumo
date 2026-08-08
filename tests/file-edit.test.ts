/**
 * File edit engine contract.
 *
 * `file_patch`'s original applier located hunks by the line number in the `@@`
 * header and never verified the lines it removed. Every failure was silent and
 * still returned `success: true`. The cases below are the reproductions of that
 * behaviour, now asserted to either apply correctly or fail loudly.
 *
 * The property that matters most is not that a patch applies, but that a patch
 * which *cannot* apply is rejected instead of writing something plausible.
 */
import { describe, expect, it } from 'vitest';
import {
  replaceOnce,
  applyEdits,
  parseUnifiedDiff,
  applyUnifiedDiff,
} from '@/lib/mcp/file-edit';

const lines = (...l: string[]) => l.join('\n');

describe('replaceOnce', () => {
  it('replaces a unique exact match', () => {
    const result = replaceOnce(lines('a', 'b', 'c'), { oldText: 'b', newText: 'B' });
    expect(result).toMatchObject({ ok: true, text: lines('a', 'B', 'c'), strategy: 'exact' });
  });

  it('reports the 1-based line of the replacement', () => {
    const result = replaceOnce(lines('a', 'b', 'c'), { oldText: 'c', newText: 'C' });
    expect(result).toMatchObject({ ok: true, line: 3 });
  });

  it('rejects an anchor that is not present', () => {
    const result = replaceOnce(lines('a', 'b'), { oldText: 'zzz', newText: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.occurrences).toBe(0);
    expect(result.error).toMatch(/not found/i);
  });

  it('rejects an ambiguous anchor instead of guessing an occurrence', () => {
    const result = replaceOnce(lines('x', 'dup', 'y', 'dup'), { oldText: 'dup', newText: 'D' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.occurrences).toBe(2);
    expect(result.error).toMatch(/ambiguous/i);
  });

  it('rejects an empty anchor', () => {
    expect(replaceOnce('abc', { oldText: '', newText: 'x' }).ok).toBe(false);
  });

  it('rejects a no-op edit', () => {
    const result = replaceOnce('abc', { oldText: 'abc', newText: 'abc' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/identical/i);
  });

  it('matches a multi-line block', () => {
    const src = lines('function foo() {', '  return 1;', '}');
    const result = replaceOnce(src, {
      oldText: lines('  return 1;'),
      newText: lines('  return 2;'),
    });
    expect(result).toMatchObject({ ok: true, text: lines('function foo() {', '  return 2;', '}') });
  });

  it('recovers when the model outdents the anchor', () => {
    const src = lines('class A {', '    method() {', '        return 1;', '    }', '}');
    // Model reproduced the block with its shared indent stripped.
    const result = replaceOnce(src, {
      oldText: lines('method() {', '    return 1;', '}'),
      newText: lines('method() {', '    return 2;', '}'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe('whitespace-normalized');
    // The file's real indentation is preserved, not the model's.
    expect(result.text).toBe(lines('class A {', '    method() {', '        return 2;', '    }', '}'));
  });

  it('does not fuzzy-match across different line structure', () => {
    const src = lines('alpha', 'beta', 'gamma');
    const result = replaceOnce(src, { oldText: lines('alpha', 'GAMMA'), newText: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('applyEdits', () => {
  it('applies edits in sequence', () => {
    const result = applyEdits(lines('a', 'b', 'c'), [
      { oldText: 'a', newText: 'A' },
      { oldText: 'c', newText: 'C' },
    ]);
    expect(result).toMatchObject({ ok: true, text: lines('A', 'b', 'C') });
  });

  it('aborts the whole batch on the first failure, naming the index', () => {
    const result = applyEdits(lines('a', 'b'), [
      { oldText: 'a', newText: 'A' },
      { oldText: 'nope', newText: 'X' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.error).toMatch(/^edit\[1\]/);
  });

  it('lets a later edit target text an earlier edit produced', () => {
    const result = applyEdits('one', [
      { oldText: 'one', newText: 'two' },
      { oldText: 'two', newText: 'three' },
    ]);
    expect(result).toMatchObject({ ok: true, text: 'three' });
  });
});

describe('parseUnifiedDiff', () => {
  it('splits hunks on @@ headers and ignores their line numbers', () => {
    const parsed = parseUnifiedDiff(
      lines('@@ -2,3 +2,3 @@', ' keep', '-old', '+new', '@@ -99,1 +99,1 @@', '-x', '+y'),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0]).toEqual({ before: ['keep', 'old'], after: ['keep', 'new'] });
  });

  it('accepts numberless "@@ ... @@" headers', () => {
    const parsed = parseUnifiedDiff(lines('@@ ... @@', ' keep', '-old', '+new'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks[0]).toEqual({ before: ['keep', 'old'], after: ['keep', 'new'] });
  });

  it('skips ---/+++ file headers before the first hunk', () => {
    const parsed = parseUnifiedDiff(lines('--- a/f.txt', '+++ b/f.txt', '@@ @@', '-old', '+new'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks[0]).toEqual({ before: ['old'], after: ['new'] });
  });

  it('strips a ```diff fence', () => {
    const parsed = parseUnifiedDiff(lines('```diff', '@@ @@', '-old', '+new', '```'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks[0]).toEqual({ before: ['old'], after: ['new'] });
  });

  it('treats a blank line inside a hunk as context', () => {
    const parsed = parseUnifiedDiff(lines('@@ @@', ' a', '', '-c', '+C'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks[0]).toEqual({ before: ['a', '', 'c'], after: ['a', '', 'C'] });
  });

  it('treats an unprefixed line inside a hunk as context', () => {
    const parsed = parseUnifiedDiff(lines('@@ @@', 'a', '-c', '+C'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks[0]!.before).toEqual(['a', 'c']);
  });

  it('drops the "\\ No newline at end of file" marker', () => {
    const parsed = parseUnifiedDiff(lines('@@ @@', '-b', '+B', '\\ No newline at end of file'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.hunks[0]).toEqual({ before: ['b'], after: ['B'] });
  });

  it('rejects a patch with no hunk header at all', () => {
    const parsed = parseUnifiedDiff(lines('-old', '+new'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/@@/);
  });

  it('rejects a header-only patch', () => {
    const parsed = parseUnifiedDiff('@@ -1,1 +1,1 @@');
    expect(parsed.ok).toBe(false);
  });
});

describe('applyUnifiedDiff', () => {
  it('applies a single-hunk patch', () => {
    const src = lines('line1', 'line2', 'line3', 'line4');
    const patch = lines('@@ -2,3 +2,3 @@', ' line2', '-line3', '+LINE3-NEW', ' line4');
    expect(applyUnifiedDiff(src, patch)).toMatchObject({
      ok: true,
      text: lines('line1', 'line2', 'LINE3-NEW', 'line4'),
    });
  });

  it('applies multiple hunks', () => {
    const src = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const patch = lines(
      '@@ -2,3 +2,3 @@',
      ' line2',
      '-line3',
      '+LINE3-NEW',
      ' line4',
      '@@ -14,3 +14,3 @@',
      ' line14',
      '-line15',
      '+LINE15-NEW',
      ' line16',
    );
    const want = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    want[2] = 'LINE3-NEW';
    want[14] = 'LINE15-NEW';
    const result = applyUnifiedDiff(src, patch);
    expect(result).toMatchObject({ ok: true, text: want.join('\n') });
  });

  it('applies a hunk whose header line numbers are stale', () => {
    // Regression: the old applier trusted "-4" and destroyed the guard clause.
    const src = lines('header', 'import a', 'import b', '', 'function foo() {', '  return 1;', '}');
    const patch = lines('@@ -4,3 +4,3 @@', ' function foo() {', '-  return 1;', '+  return 2;', ' }');
    expect(applyUnifiedDiff(src, patch)).toMatchObject({
      ok: true,
      text: lines('header', 'import a', 'import b', '', 'function foo() {', '  return 2;', '}'),
    });
  });

  it('rejects a hunk whose removal line does not exist in the file', () => {
    // Regression: the old applier deleted line 2 regardless of its content.
    const result = applyUnifiedDiff(lines('a', 'b', 'c'), lines('@@ -2,1 +2,1 @@', '-TOTALLY_WRONG', '+B'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/hunk 1/);
    expect(result.error).toMatch(/not found/i);
  });

  it('rejects a patch with no @@ header instead of silently doing nothing', () => {
    // Regression: this returned success:true on a completely unchanged file.
    const result = applyUnifiedDiff(lines('a', 'b', 'c'), lines('-b', '+B'));
    expect(result.ok).toBe(false);
  });

  it('preserves Markdown bullets used as context', () => {
    // Regression: "- item one" as a context line was read as a deletion and the
    // old applier destroyed the surrounding list.
    const src = lines('# Todo', '- item one', '- item two', '- item three');
    const patch = lines('@@ @@', ' - item one', '-- item two', '+- ITEM TWO', ' - item three');
    expect(applyUnifiedDiff(src, patch)).toMatchObject({
      ok: true,
      text: lines('# Todo', '- item one', '- ITEM TWO', '- item three'),
    });
  });

  it('preserves a --- horizontal rule that is not a file header', () => {
    const src = lines('# Title', 'text', '---', 'more');
    const patch = lines('@@ @@', ' # Title', '+## Sub', ' text');
    expect(applyUnifiedDiff(src, patch)).toMatchObject({
      ok: true,
      text: lines('# Title', '## Sub', 'text', '---', 'more'),
    });
  });

  it('handles a pure deletion hunk', () => {
    const src = lines('a', 'b', 'c', 'd');
    const patch = lines('@@ @@', ' b', '-c', '-d');
    expect(applyUnifiedDiff(src, patch)).toMatchObject({ ok: true, text: lines('a', 'b') });
  });

  it('handles an insertion anchored on context', () => {
    const src = lines('a', 'b');
    const patch = lines('@@ @@', ' a', '+MID', ' b');
    expect(applyUnifiedDiff(src, patch)).toMatchObject({ ok: true, text: lines('a', 'MID', 'b') });
  });

  it('rejects an insertion-only hunk with no context to anchor on', () => {
    const result = applyUnifiedDiff(lines('a', 'b'), lines('@@ @@', '+ORPHAN'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/anchor/i);
  });

  it('applies hunks given in descending order', () => {
    const src = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
    const patch = lines('@@ @@', '-L8', '+L8-NEW', '@@ @@', '-L2', '+L2-NEW');
    const want = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    want[7] = 'L8-NEW';
    want[1] = 'L2-NEW';
    expect(applyUnifiedDiff(src, patch)).toMatchObject({ ok: true, text: want.join('\n') });
  });

  it('ignores a context-only hunk rather than failing', () => {
    const result = applyUnifiedDiff(lines('a', 'b'), lines('@@ @@', ' a', ' b'));
    expect(result).toMatchObject({ ok: true, text: lines('a', 'b'), hunks: 0 });
  });

  it('reports which strategies were needed', () => {
    const src = lines('a', 'b', 'c');
    const result = applyUnifiedDiff(src, lines('@@ @@', '-b', '+B'));
    expect(result).toMatchObject({ ok: true, strategies: ['exact'] });
  });
});

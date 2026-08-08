/**
 * Text edit engine for the built-in File MCP server.
 *
 * ## Why this module exists
 *
 * `file_patch` used to hand the model's unified diff to a 45-line applier that
 * located each hunk **purely by the line number in the `@@` header** and never
 * checked that the lines it deleted were the lines the patch claimed to delete.
 * Every failure mode was silent, and every one of them still returned
 * `success: true`:
 *
 *  - Stale/off-by-N line numbers deleted innocent lines and left the target
 *    line untouched. (`@@ -4,3` on a file where the target sits at line 6
 *    produced `"  return 2;\n  return 1;\n}"` — the guard clause was gone.)
 *  - A patch with no `@@` header at all — a very common model output — matched
 *    no hunk, so the loop did nothing and reported success on an unchanged file.
 *  - Markdown/diff content whose own lines begin with `-` or `+` (bullet lists,
 *    nested diffs) was parsed as removals/additions of the *outer* patch.
 *  - Hunk line counts (`,3`) were parsed and then ignored, so a miscounted
 *    header was never caught.
 *
 * ## The fix, and why it is shaped this way
 *
 * Every mainstream coding agent that survives contact with real models reached
 * the same two conclusions, from different directions:
 *
 *  1. **Never trust model-supplied line numbers.** Aider's write-up on unified
 *     diffs is explicit — "GPT is terrible at working with source code line
 *     numbers" — and it therefore instructs the model to emit `@@ ... @@` with
 *     no numbers and treats each hunk as a *search/replace* over the file text.
 *     Anthropic's text-editor tool and the Cursor/Copilot edit tools skip diffs
 *     entirely: the primitive is `str_replace(old_string, new_string)`.
 *  2. **Verify, then be flexible.** An edit must fail loudly when the anchor
 *     text is not found, and must retry with normalized whitespace/indentation
 *     before giving up. Aider reports a ~9x jump in edit errors when its
 *     flexible-apply strategies are disabled.
 *
 * So this module provides one verified primitive, `replaceOnce`, and layers a
 * line-number-free unified-diff parser on top of it. The line numbers in an
 * incoming `@@` header are parsed only to order hunks; they never locate an
 * edit. Anchors are matched by content, and a hunk that does not match is a
 * hard error carrying a diagnosis the model can act on.
 */

/** A single anchored replacement, the `str_replace` primitive. */
export interface ReplaceEdit {
  oldText: string;
  newText: string;
}

/** How `replaceOnce` located the anchor, surfaced so callers can warn. */
export type MatchStrategy = 'exact' | 'trimmed-indent' | 'whitespace-normalized';

export interface ReplaceSuccess {
  ok: true;
  text: string;
  /** Which fallback (if any) was needed to find the anchor. */
  strategy: MatchStrategy;
  /** 1-based line where the replacement landed, for reporting only. */
  line: number;
}

export interface ReplaceFailure {
  ok: false;
  /** Model-facing explanation plus the corrective action to take. */
  error: string;
  /** Number of times the anchor matched: 0 (not found) or >1 (ambiguous). */
  occurrences: number;
}

export type ReplaceResult = ReplaceSuccess | ReplaceFailure;

/** Longest run of leading whitespace shared by every non-blank line. */
function commonIndent(lines: string[]): string {
  let indent: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const lead = line.slice(0, line.length - line.trimStart().length);
    if (indent === null) {
      indent = lead;
      continue;
    }
    let i = 0;
    while (i < indent.length && i < lead.length && indent[i] === lead[i]) i++;
    indent = indent.slice(0, i);
  }
  return indent ?? '';
}

/** Strip the shared leading indentation from a block. */
function dedent(text: string): string {
  const lines = text.split('\n');
  const indent = commonIndent(lines);
  if (!indent) return text;
  return lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
}

/** Re-apply an indent to every non-blank line of a block. */
function indentBlock(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? l : indent + l))
    .join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/** 1-based line number of a character index. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Find a block of lines by comparing them with whitespace collapsed.
 *
 * This is the last-resort strategy, for the case Aider calls "GPT outdents all
 * of the code": the anchor is textually right but its indentation was reflowed.
 * Matching per-line on `trim()` tolerates that without the false positives a
 * character-level fuzzy match would produce, because line *structure* still has
 * to line up exactly.
 */
function findByNormalizedLines(
  haystackLines: string[],
  needleLines: string[],
): { start: number; count: number } | null {
  if (needleLines.length === 0 || needleLines.length > haystackLines.length) return null;
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const needle = needleLines.map(norm);
  let found: { start: number; count: number } | null = null;

  for (let i = 0; i + needle.length <= haystackLines.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (norm(haystackLines[i + j]!) !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // Ambiguity is a failure, not a coin flip.
    if (found) return null;
    found = { start: i, count: needle.length };
  }
  return found;
}

/**
 * Replace `oldText` with `newText`, exactly once, verified.
 *
 * Escalates through three strategies and stops at the first that yields a
 * *unique* match:
 *   1. `exact`                  — verbatim substring.
 *   2. `trimmed-indent`         — anchor dedented, match found in dedented
 *                                 space, replacement re-indented to the target.
 *   3. `whitespace-normalized`  — per-line `trim()` + collapsed inner runs.
 *
 * Returns a failure — never a partial or best-guess write — when the anchor is
 * missing or appears more than once. An ambiguous anchor is the one case where
 * "do something" is strictly worse than "ask for a longer anchor", because the
 * model has no way to tell which occurrence was hit.
 */
export function replaceOnce(source: string, edit: ReplaceEdit): ReplaceResult {
  const { oldText, newText } = edit;

  if (oldText === '') {
    return {
      ok: false,
      occurrences: 0,
      error:
        'oldText must not be empty. To create or overwrite a whole file use file_write; ' +
        'to insert text, anchor it on an adjacent line that already exists.',
    };
  }

  if (oldText === newText) {
    return {
      ok: false,
      occurrences: 0,
      error: 'oldText and newText are identical, so this edit would do nothing.',
    };
  }

  // --- 1. exact ---------------------------------------------------------
  const exactCount = countOccurrences(source, oldText);
  if (exactCount === 1) {
    const at = source.indexOf(oldText);
    return {
      ok: true,
      text: source.slice(0, at) + newText + source.slice(at + oldText.length),
      strategy: 'exact',
      line: lineAt(source, at),
    };
  }
  if (exactCount > 1) {
    return {
      ok: false,
      occurrences: exactCount,
      error:
        `oldText matches ${exactCount} places in the file, so the edit is ambiguous. ` +
        'Include more surrounding context in oldText so it identifies exactly one location.',
    };
  }

  // --- 2. dedented ------------------------------------------------------
  const dedentedOld = dedent(oldText);
  if (dedentedOld !== oldText) {
    const dedentedCount = countOccurrences(source, dedentedOld);
    if (dedentedCount === 1) {
      const at = source.indexOf(dedentedOld);
      return {
        ok: true,
        text: source.slice(0, at) + dedent(newText) + source.slice(at + dedentedOld.length),
        strategy: 'trimmed-indent',
        line: lineAt(source, at),
      };
    }
  }

  // --- 3. whitespace-normalized, line structured ------------------------
  const sourceLines = source.split('\n');
  const oldLines = oldText.split('\n');
  const hit = findByNormalizedLines(sourceLines, oldLines);
  if (hit) {
    const target = sourceLines.slice(hit.start, hit.start + hit.count);
    // Adopt the file's real indentation rather than the model's guess.
    const targetIndent = commonIndent(target);
    const rebuilt = indentBlock(dedent(newText), targetIndent);
    const next = [
      ...sourceLines.slice(0, hit.start),
      ...rebuilt.split('\n'),
      ...sourceLines.slice(hit.start + hit.count),
    ];
    return {
      ok: true,
      text: next.join('\n'),
      strategy: 'whitespace-normalized',
      line: hit.start + 1,
    };
  }

  return {
    ok: false,
    occurrences: 0,
    error:
      'oldText was not found in the file. Call file_read first and copy the exact text ' +
      'you want to replace, including indentation. Do not guess line numbers or reconstruct ' +
      'the text from memory.',
  };
}

/** Apply edits sequentially; the first failure aborts the whole batch. */
export function applyEdits(
  source: string,
  edits: ReplaceEdit[],
): { ok: true; text: string; applied: ReplaceSuccess[] } | { ok: false; error: string; index: number } {
  let text = source;
  const applied: ReplaceSuccess[] = [];

  for (let i = 0; i < edits.length; i++) {
    const result = replaceOnce(text, edits[i]!);
    if (!result.ok) {
      // All-or-nothing: a half-applied batch leaves the file in a state neither
      // side can reason about, and the model cannot tell which edits survived.
      return { ok: false, error: `edit[${i}]: ${result.error}`, index: i };
    }
    text = result.text;
    applied.push(result);
  }

  return { ok: true, text, applied };
}

// ---------------------------------------------------------------------------
// Unified diff -> verified replacements
// ---------------------------------------------------------------------------

export interface ParsedHunk {
  /** ' ' context and '-' removal lines, i.e. the text to search for. */
  before: string[];
  /** ' ' context and '+' addition lines, i.e. the text to write. */
  after: string[];
}

export interface ParseDiffSuccess {
  ok: true;
  hunks: ParsedHunk[];
}

export interface ParseDiffFailure {
  ok: false;
  error: string;
}

/** Strip a ```/```diff fence the model wrapped around its patch. */
function stripFence(patch: string): string {
  const lines = patch.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  if (start < end && /^```/.test(lines[start]!.trim())) {
    start++;
    if (end > start && lines[end - 1]!.trim() === '```') end--;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Parse a unified diff into content-anchored hunks.
 *
 * Deliberately ignores the numbers in `@@` headers. They are the single largest
 * source of misapplied patches — models routinely emit stale or off-by-N line
 * numbers — and they are redundant: the context and removal lines already say
 * where the hunk goes, and unlike a line number they can be *verified*.
 * `@@ ... @@` with no numbers, which is what Aider asks models to emit, is
 * therefore accepted too.
 *
 * `---`/`+++` file headers are only treated as headers immediately before the
 * first hunk. Inside a hunk body, a `-`/`+` line is content: Markdown files use
 * `---` as a horizontal rule and `- ` for bullets, and mistaking those for
 * diff syntax corrupted exactly the files this server exists to hold.
 */
export function parseUnifiedDiff(patch: string): ParseDiffSuccess | ParseDiffFailure {
  const body = stripFence(patch);
  const lines = body.split('\n');
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  let seenHunkHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/^@@/.test(line)) {
      current = { before: [], after: [] };
      hunks.push(current);
      seenHunkHeader = true;
      continue;
    }

    if (!seenHunkHeader) {
      // Pre-hunk preamble: file headers and any prose the model added.
      continue;
    }

    // "\ No newline at end of file" is metadata, not content.
    if (line.startsWith('\\')) continue;

    if (!current) continue;

    if (line.startsWith('-')) {
      current.before.push(line.slice(1));
    } else if (line.startsWith('+')) {
      current.after.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      current.before.push(line.slice(1));
      current.after.push(line.slice(1));
    } else if (line === '') {
      // A blank context line. Real `diff` emits " ", but models drop the space
      // constantly; treating it as context is the only reading that preserves
      // the line, and dropping it silently shifted every anchor below it.
      current.before.push('');
      current.after.push('');
    } else {
      // An unprefixed non-empty line. Same reasoning: read it as context.
      current.before.push(line);
      current.after.push(line);
    }
  }

  if (hunks.length === 0) {
    return {
      ok: false,
      error:
        'No @@ hunk header found in the patch. A unified diff needs at least one hunk ' +
        'starting with "@@". Prefer file_edit with oldText/newText, which needs no diff syntax.',
    };
  }

  const usable = hunks.filter((h) => h.before.length > 0 || h.after.length > 0);
  if (usable.length === 0) {
    return { ok: false, error: 'The patch contains hunk headers but no content lines.' };
  }

  return { ok: true, hunks: usable };
}

/**
 * Apply a unified diff by turning every hunk into a verified replacement.
 *
 * A hunk whose `before` text cannot be located is a hard failure that names the
 * hunk, because the old behaviour — write something anyway, report success —
 * meant the model never learned its patch was wrong and the user's file was
 * quietly damaged.
 */
export function applyUnifiedDiff(
  source: string,
  patch: string,
): { ok: true; text: string; hunks: number; strategies: MatchStrategy[] } | { ok: false; error: string } {
  const parsed = parseUnifiedDiff(patch);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  let text = source;
  const strategies: MatchStrategy[] = [];

  for (let i = 0; i < parsed.hunks.length; i++) {
    const hunk = parsed.hunks[i]!;
    const before = hunk.before.join('\n');
    const after = hunk.after.join('\n');

    // Pure insertion with no context: there is nothing to anchor on.
    if (before === '') {
      return {
        ok: false,
        error:
          `hunk ${i + 1} has only added lines and no context, so there is nowhere to anchor it. ` +
          'Include at least one surrounding context line (prefixed with a space).',
      };
    }

    if (before === after) continue; // context-only hunk, nothing to do

    const result = replaceOnce(text, { oldText: before, newText: after });
    if (!result.ok) {
      return { ok: false, error: `hunk ${i + 1}: ${result.error}` };
    }
    text = result.text;
    strategies.push(result.strategy);
  }

  return { ok: true, text, hunks: strategies.length, strategies };
}

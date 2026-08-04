/**
 * Search the snapshot tree instead of dumping it.
 *
 * A 400-item list snapshots to ~57k characters (research §3). Returning only the
 * matching nodes with their path from the root is how the agent locates a ref on
 * a large page without paying for the whole tree — the same trade-off
 * playwright-mcp makes with `browser_find`.
 */

import { buildAriaTree, distill, renderAriaTree, type AriaNode, type SnapshotOptions } from './aria-snapshot';
import type { PageFindMatch } from './messages';

export interface FindOptions extends SnapshotOptions {
  text?: string;
  regex?: string;
  /** Descendant levels rendered under each match. */
  context?: number;
  /** Cap on matches returned; further matches are only counted. */
  limit?: number;
}

export interface FindResult {
  matches: PageFindMatch[];
  totalMatches: number;
}

const DEFAULT_CONTEXT = 2;
const DEFAULT_LIMIT = 20;

export function findInAriaTree(doc: Document, options: FindOptions): FindResult | { error: string } {
  const matcher = buildMatcher(options);
  if ('error' in matcher) return matcher;

  const root = buildAriaTree(doc, options);
  distill(root);

  const context = options.context ?? DEFAULT_CONTEXT;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const matches: PageFindMatch[] = [];
  let totalMatches = 0;

  const walk = (node: AriaNode, path: string[]): void => {
    const selfPath = [...path, describe(node)];
    if (matcher.test(node)) {
      totalMatches++;
      if (matches.length < limit) {
        matches.push({
          path: path.join(' > '),
          lines: renderMatch(node, context),
          ref: node.ref,
        });
        // Do not descend into a match: its children are already the context.
        return;
      }
    }
    for (const child of node.children) {
      if (typeof child !== 'string') walk(child, selfPath);
    }
  };

  for (const child of root.children) {
    if (typeof child !== 'string') walk(child, [describe(root)]);
  }

  return { matches, totalMatches };
}

function describe(node: AriaNode): string {
  return node.name ? `${node.role} "${node.name}"` : node.role;
}

/**
 * Render the matched node *and* `context` levels beneath it.
 *
 * `renderAriaTree` walks a node's children, so handing it the match directly
 * would print the context while omitting the line the user searched for. Wrapping
 * the match in a synthetic parent puts it back in the output.
 */
function renderMatch(node: AriaNode, context: number): string[] {
  const wrapper: AriaNode = {
    ...node,
    role: 'generic',
    name: '',
    props: {},
    ref: undefined,
    level: undefined,
    checked: undefined,
    disabled: undefined,
    expanded: undefined,
    selected: undefined,
    children: [node],
  };
  return renderAriaTree(wrapper, { depth: context + 1 })
    .split('\n')
    .filter(Boolean);
}

interface Matcher {
  test(node: AriaNode): boolean;
}

function buildMatcher(options: FindOptions): Matcher | { error: string } {
  if (options.text && options.regex) {
    return { error: 'Provide either text or regex, not both' };
  }
  if (options.regex) {
    const compiled = compileRegex(options.regex);
    if ('error' in compiled) return compiled;
    const { regex } = compiled;
    return {
      test: (node) => regex.test(searchableText(node)),
    };
  }
  if (options.text) {
    const needle = options.text.toLowerCase();
    return {
      test: (node) => searchableText(node).toLowerCase().includes(needle),
    };
  }
  return { error: 'Provide text or regex to search for' };
}

/** Everything about a node a user might search for, minus its subtree. */
function searchableText(node: AriaNode): string {
  const own = node.children
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
  return [node.role, node.name, own, ...Object.values(node.props)].filter(Boolean).join(' ');
}

/** Accept `/pattern/flags` as well as a bare pattern. */
function compileRegex(input: string): { regex: RegExp } | { error: string } {
  const slashed = /^\/(.*)\/([a-z]*)$/.exec(input);
  try {
    return slashed
      ? { regex: new RegExp(slashed[1]!, slashed[2]) }
      : { regex: new RegExp(input) };
  } catch (error) {
    return { error: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` };
  }
}

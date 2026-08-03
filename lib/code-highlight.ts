/**
 * Lazy-loaded Shiki syntax highlighter for the file preview page.
 *
 * The whole module is intentionally kept out of the main preview bundle and
 * pulled in via dynamic `import()` only when a code file is rendered. It uses
 * the pure-JS regex engine (no WASM) so it works under the extension's CSP,
 * and emits dual light/dark themes via CSS variables (`--shiki-light/dark`)
 * that react to the app's `.dark` class without re-highlighting.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import sql from 'shiki/langs/sql.mjs';
import svelte from 'shiki/langs/svelte.mjs';
import toml from 'shiki/langs/toml.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import vue from 'shiki/langs/vue.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

/** Curated languages aligned with `getLanguageFromMime` in lib/mcp/file-storage.ts. */
export const SUPPORTED_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'graphql',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'markdown',
  'python',
  'ruby',
  'rust',
  'sql',
  'svelte',
  'toml',
  'typescript',
  'vue',
  'xml',
  'yaml',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Common aliases/extensions so a loose language id still resolves to a grammar. */
const LANG_ALIASES: Record<string, SupportedLanguage> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  md: 'markdown',
  mdown: 'markdown',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  cs: 'csharp',
  csharp: 'csharp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
};

/** Resolve a language identifier to a supported Shiki language, if possible. */
export function normalizeLanguage(language: string): SupportedLanguage | undefined {
  const lang = language.trim().toLowerCase();
  if (!lang) return undefined;
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) {
    return lang as SupportedLanguage;
  }
  return LANG_ALIASES[lang];
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    themes: [githubLight, githubDark],
    langs: [
      bash,
      c,
      cpp,
      csharp,
      css,
      graphql,
      go,
      html,
      java,
      javascript,
      json,
      markdown,
      python,
      ruby,
      rust,
      sql,
      svelte,
      toml,
      typescript,
      vue,
      xml,
      yaml,
    ],
  });
  return highlighterPromise;
}

/**
 * Highlight source code into HTML. Unknown languages fall back to plain text.
 * The result uses the `github-light`/`github-dark` dual-theme CSS variables.
 */
export async function highlightCode(code: string, language: string): Promise<string> {
  const lang = normalizeLanguage(language) ?? 'plaintext';
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
  });
}

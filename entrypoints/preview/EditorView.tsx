import { useEffect, useRef, useCallback } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { githubLight } from '@uiw/codemirror-theme-github';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';

interface CodeEditorProps {
  content: string;
  language: string;
  isDark: boolean;
  onSave: (content: string) => void;
  onChange: (content: string) => void;
}

/**
 * Get the CodeMirror language extension for a given language identifier.
 * Lazy-loaded to keep the initial bundle small.
 */
async function getLanguageExtension(lang: string): Promise<Extension | null> {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'jsx':
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({
        jsx: lang === 'jsx' || lang === 'tsx',
        typescript: lang === 'typescript' || lang === 'tsx',
      });
    }
    case 'html':
    case 'vue':
    case 'svelte': {
      const { html } = await import('@codemirror/lang-html');
      return html();
    }
    case 'css': {
      const { css } = await import('@codemirror/lang-css');
      return css();
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json');
      return json();
    }
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown');
      return markdown();
    }
    case 'python': {
      const { python } = await import('@codemirror/lang-python');
      return python();
    }
    case 'xml': {
      const { xml } = await import('@codemirror/lang-xml');
      return xml();
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/lang-yaml');
      return yaml();
    }
    default:
      return null;
  }
}

/**
 * CodeMirror 6 editor component for the preview page.
 *
 * Uses GitHub Light theme in light mode and VS Code Dark theme in dark mode
 * for proper, battle-tested syntax highlighting colours.
 */
export function CodeEditor({ content, language, isDark, onSave, onChange }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);

  onSaveRef.current = onSave;
  onChangeRef.current = onChange;

  // Track latest content from parent to detect external updates
  const lastExternalContent = useRef(content);

  const createEditor = useCallback(async () => {
    if (!containerRef.current) return;

    // Destroy existing editor
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const langExt = await getLanguageExtension(language);

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: (view) => {
          onSaveRef.current(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const extensions: Extension[] = [
      // Theme first so it provides base styling
      isDark ? vscodeDark : githubLight,
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      history(),
      saveKeymap,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      // Layout overrides that apply regardless of colour theme
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '13px',
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        },
      }),
    ];

    if (langExt) {
      extensions.push(langExt);
    }

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    lastExternalContent.current = content;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, isDark]);

  // Initialize editor
  useEffect(() => {
    void createEditor();
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [createEditor]);

  // Sync external content changes (e.g., file reloaded from storage)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content !== lastExternalContent.current) {
      const currentDoc = view.state.doc.toString();
      if (content !== currentDoc) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
        });
      }
      lastExternalContent.current = content;
    }
  }, [content]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}

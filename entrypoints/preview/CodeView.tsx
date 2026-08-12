import { useEffect, useMemo, useState } from 'react';
import { selectAllRootProps } from '@/lib/use-select-all-scope';

interface CodeViewProps {
  content: string;
  language: string;
}

/**
 * Source-code viewer with Shiki syntax highlighting.
 *
 * The Shiki highlighter is lazy-loaded via dynamic import, so the preview page
 * stays light for non-code files (images, markdown, plain text). While the
 * highlighter loads (or if it fails) the raw source is shown instead.
 */
export function CodeView({ content, language }: CodeViewProps) {
  const [html, setHtml] = useState<string | null>(null);

  const lines = useMemo(() => content.split('\n'), [content]);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);

    import('@/lib/code-highlight')
      .then(({ highlightCode }) => highlightCode(content, language))
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Keep the raw-source fallback if highlighting fails.
      });

    return () => {
      cancelled = true;
    };
  }, [content, language]);

  return (
    <div className="code-view h-full overflow-auto">
      <div className="flex text-sm font-mono min-w-fit">
        {/*
          Line numbers. Presentational only: hidden from assistive tech and kept
          outside the select-all root so "select all, copy" yields pastable source
          rather than source interleaved with line numbers.
        */}
        <div
          aria-hidden="true"
          className="shrink-0 sticky left-0 py-4 px-2 text-right select-none border-r border-border bg-muted/30 z-10"
        >
          {lines.map((_, i) => (
            <div key={i} className="text-xs text-muted-foreground leading-5 px-1">
              {i + 1}
            </div>
          ))}
        </div>

        {/* Code content — the select-all scope for this view. */}
        <div className="flex-1 py-4 px-4" {...selectAllRootProps}>
          {html ? (
            <div className="leading-5" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="leading-5 whitespace-pre">
              {lines.map((line, i) => (
                <div key={i} className="leading-5 whitespace-pre">
                  {line || ' '}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

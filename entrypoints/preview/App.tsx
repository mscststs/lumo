import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  X,
  Copy,
  Check,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Code,
  Eye,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { cn } from '@/lib/utils';
import { ThemeInit } from '@/lib/theme';
import { CodeView } from './CodeView';
import {
  fileStorage,
  type FileMetadata,
  getPreviewCategory,
  getLanguageFromMime,
} from '@/lib/mcp';

type ViewMode = 'rendered' | 'source';

export default function App() {
  const { t } = useTranslation();
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [viewMode, setViewMode] = useState<ViewMode>('rendered');
  const [copied, setCopied] = useState(false);

  const fileName = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('file');
  }, []);

  const loadFile = useCallback(async () => {
    if (!fileName) {
      setError('No file specified');
      setLoading(false);
      return;
    }

    try {
      const meta = await fileStorage.getMetadata(fileName);
      if (!meta) {
        setError(t('options.preview.fileNotFound'));
        setLoading(false);
        return;
      }

      setMetadata(meta);
      const category = getPreviewCategory(meta.mimeType);

      if (category === 'image') {
        const url = await fileStorage.getObjectUrl(fileName);
        setObjectUrl(url);
      } else if (category === 'text') {
        const text = await fileStorage.readFileAsText(fileName);
        setContent(text);
      } else {
        setError(t('options.preview.unsupported'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fileName, t]);

  useEffect(() => {
    loadFile();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loadFile]);

  const handleDownload = async () => {
    if (!fileName) return;
    const blob = await fileStorage.readFileAsBlob(fileName);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    window.close();
  };

  const handleCopy = async () => {
    if (content == null) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable in some contexts; ignore.
    }
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z + 25, 300));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 25, 25));
  const handleZoomReset = () => setZoom(100);

  const category = metadata ? getPreviewCategory(metadata.mimeType) : null;
  const showModeSwitch =
    metadata &&
    (metadata.mimeType === 'text/markdown' || metadata.mimeType === 'text/html');

  return (
    <div className="flex flex-col h-screen w-full bg-background">
      <ThemeInit />

      {/* Top Toolbar - 32px height */}
      <header className="h-8 shrink-0 flex items-center justify-between px-3 border-b border-border bg-card">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs font-medium text-foreground truncate max-w-[300px]">
            {fileName || t('options.preview.title')}
          </span>
          {metadata && (
            <span className="text-xs text-muted-foreground ml-2 shrink-0">
              {metadata.mimeType}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Mode switch for markdown/html */}
          {showModeSwitch && (
            <button
              onClick={() => setViewMode((m) => (m === 'rendered' ? 'source' : 'rendered'))}
              className="flex items-center gap-1 h-6 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title={t('options.preview.switchMode')}
            >
              {viewMode === 'rendered' ? (
                <>
                  <Code className="h-3 w-3" />
                  <span className="hidden sm:inline">{t('options.preview.source')}</span>
                </>
              ) : (
                <>
                  <Eye className="h-3 w-3" />
                  <span className="hidden sm:inline">{t('options.preview.rendered')}</span>
                </>
              )}
            </button>
          )}

          {/* Zoom controls */}
          {category === 'image' && (
            <>
              <ToolbarButton onClick={handleZoomOut} title={t('options.preview.zoomOut')}>
                <ZoomOut className="h-3.5 w-3.5" />
              </ToolbarButton>
              <span className="text-xs text-muted-foreground min-w-[36px] text-center">
                {zoom}%
              </span>
              <ToolbarButton onClick={handleZoomIn} title={t('options.preview.zoomIn')}>
                <ZoomIn className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton onClick={handleZoomReset} title={t('options.preview.resetZoom')}>
                <RotateCcw className="h-3.5 w-3.5" />
              </ToolbarButton>
            </>
          )}

          {/* Copy source (text/code files) */}
          {content !== null && (
            <ToolbarButton onClick={handleCopy} title={t('options.preview.copy')}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </ToolbarButton>
          )}

          {/* Download */}
          <ToolbarButton onClick={handleDownload} title={t('options.preview.download')}>
            <Download className="h-3.5 w-3.5" />
          </ToolbarButton>

          {/* Close */}
          <ToolbarButton onClick={handleClose} title={t('options.preview.close')}>
            <X className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      </header>

      {/* Preview Content Area */}
      <main className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('common.loading')}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {error}
          </div>
        )}

        {!loading && !error && category === 'image' && objectUrl && (
          <ImagePreview src={objectUrl} zoom={zoom} />
        )}

        {!loading && !error && category === 'text' && content !== null && metadata && (
          <TextPreview
            content={content}
            mimeType={metadata.mimeType}
            viewMode={viewMode}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Image preview with zoom support.
 */
function ImagePreview({ src, zoom }: { src: string; zoom: number }) {
  return (
    <div className="flex items-center justify-center min-h-full p-4 bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
      <img
        src={src}
        alt="Preview"
        className="max-w-none transition-transform duration-150"
        style={{ width: `${zoom}%`, height: 'auto' }}
      />
    </div>
  );
}

/**
 * Text preview with support for:
 * - Markdown (rendered via Streamdown or source view)
 * - HTML (rendered in iframe or source view)
 * - Code files (syntax highlighted via Shiki, with copy button)
 * - Plain text
 */
function TextPreview({
  content,
  mimeType,
  viewMode,
}: {
  content: string;
  mimeType: string;
  viewMode: ViewMode;
}) {
  // Markdown
  if (mimeType === 'text/markdown') {
    if (viewMode === 'source') {
      return <CodeView content={content} language="markdown" />;
    }
    return (
      <div className="p-6 max-w-3xl mx-auto sd-message-response break-words">
        <Streamdown plugins={{ code, cjk }}>{content}</Streamdown>
      </div>
    );
  }

  // HTML
  if (mimeType === 'text/html') {
    if (viewMode === 'source') {
      return <CodeView content={content} language="html" />;
    }
    return <HtmlPreview content={content} />;
  }

  // Code files - syntax highlighted
  const language = getLanguageFromMime(mimeType);
  if (language && language !== 'csv') {
    return <CodeView content={content} language={language} />;
  }

  // Plain text / CSV / others
  return (
    <div className="p-4">
      <pre className="text-sm font-mono text-foreground whitespace-pre-wrap break-words">
        {content}
      </pre>
    </div>
  );
}

/**
 * HTML rendered preview using a manifest-declared sandbox page.
 *
 * Chrome Extension MV3 enforces strict CSP that blocks inline scripts even in
 * Blob URL iframes. The workaround is to use a page declared in
 * manifest.sandbox which has a relaxed CSP. We load sandbox.html as an iframe,
 * then postMessage the HTML content to it for rendering.
 */
function HtmlPreview({ content }: { content: string }) {
  const iframeRef = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      if (!iframe) return;

      const sendContent = () => {
        iframe.contentWindow?.postMessage({ html: content }, '*');
      };

      // Listen for sandbox ready signal
      const handleMessage = (e: MessageEvent) => {
        if (e.data?.type === 'sandbox-ready') {
          sendContent();
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);

      // Also try sending after load (in case ready was missed)
      iframe.addEventListener('load', () => {
        setTimeout(sendContent, 50);
      });
    },
    [content],
  );

  const sandboxUrl = chrome.runtime.getURL('/sandbox.html');

  return (
    <iframe
      ref={iframeRef}
      src={sandboxUrl}
      className="w-full h-full border-none bg-white"
      title="HTML Preview"
    />
  );
}

/**
 * Compact, uniformly-sized icon button for the preview toolbar.
 */
function ToolbarButton({
  onClick,
  title,
  children,
  className,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center h-6 w-6 shrink-0 rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronUp, Download, Eye, FileText, Image, FileCode, File, CornerDownLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fileStorage, type FileMetadata, getPreviewCategory } from '@/lib/mcp';
import { useEvent } from '@/lib/event-bus';
import { setFileRefDragData } from '@/lib/file-drag';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  const category = getPreviewCategory(mimeType);
  switch (category) {
    case 'image':
      return <Image className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case 'text':
      if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('json')) {
        return <FileCode className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
      }
      return <FileText className="h-3.5 w-3.5 text-orange-500 shrink-0" />;
    default:
      return <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ConversationFilesProps {
  conversationId: string | null;
  onReference: (fileName: string) => void;
}

export function ConversationFiles({ conversationId, onReference }: ConversationFilesProps) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [expanded, setExpanded] = useState(false);

  const loadFiles = useCallback(async () => {
    if (!conversationId) {
      setFiles([]);
      return;
    }
    try {
      const list = await fileStorage.getFilesByConversation(conversationId);
      setFiles(list);
    } catch {
      // Ignore errors silently
    }
  }, [conversationId]);

  // Initial load. Updates arrive as events, so there is nothing to poll.
  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  /**
   * Live updates.
   *
   * This replaced a 3-second `setInterval` that hit IndexedDB forever, even while
   * idle and even while the section was collapsed — the pattern
   * `useConversations` deliberately avoids so a background write does not wake
   * every panel. The file tools run in this same context, and the bus delivers
   * locally as well as across contexts, so a tool write is seen immediately.
   */
  useEvent('files:changed', () => {
    void loadFiles();
  });

  // Reset expanded state when conversation changes
  useEffect(() => {
    setExpanded(false);
  }, [conversationId]);

  const handlePreview = async (name: string) => {
    const url = chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`);
    // Find existing preview tab for this file and focus it instead of opening a new one
    try {
      const tabs = await chrome.tabs.query({ url });
      const existing = tabs[0];
      if (existing?.id != null) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId != null) {
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return;
      }
    } catch {
      // Fallback to creating a new tab if query fails
    }
    chrome.tabs.create({ url });
  };

  const handleDownload = async (name: string) => {
    const blob = await fileStorage.readFileAsBlob(name);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const filename = name.includes('/') ? name.split('/').pop()! : name;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // Don't render anything if no files
  if (files.length === 0) return null;

  return (
    <div className="px-3 shrink-0">
      <div className="rounded-lg border border-border bg-muted/30 overflow-hidden">
        {/* Trigger bar */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <File className="h-3.5 w-3.5" />
            <span>{t('sidebar.files.count', { count: files.length })}</span>
            <span className="text-muted-foreground/60">
              ({formatSize(files.reduce((sum, f) => sum + f.size, 0))})
            </span>
          </span>
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </motion.div>
        </button>

        {/* Expandable file list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="border-t border-border max-h-[140px] overflow-y-auto scrollbar-lumo">
                {files.map((file) => (
                  <FileItem
                    key={file.name}
                    file={file}
                    onPreview={() => handlePreview(file.name)}
                    onDownload={() => void handleDownload(file.name)}
                    onReference={() => onReference(file.name)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── File Item ────────────────────────────────────────────────────────────────

function FileItem({
  file,
  onPreview,
  onDownload,
  onReference,
}: {
  file: FileMetadata;
  onPreview: () => void;
  onDownload: () => void;
  onReference: () => void;
}) {
  const { t } = useTranslation();
  const previewable = getPreviewCategory(file.mimeType) !== 'unsupported';
  // Strip folder prefix for display
  const displayName = file.name.includes('/') ? file.name.split('/').pop()! : file.name;

  const handleDragStart = (e: React.DragEvent) => {
    // Custom MIME type plus a plain-text fallback, so App.tsx can tell an
    // internal file drag from a page drag.
    setFileRefDragData(e.dataTransfer, file.name);
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/20 transition-colors group"
      draggable
      onDragStart={handleDragStart}
    >
      {/* File name + icon area: click to preview, draggable */}
      <div
        className="flex items-center gap-2 flex-1 min-w-0 cursor-default active:cursor-grabbing"
        onClick={onPreview}
      >
        <FileIcon mimeType={file.mimeType} />
        <span className="text-xs truncate flex-1 min-w-0" title={file.name}>
          {displayName}
        </span>
      </div>
      <span className="text-[10px] text-muted-foreground shrink-0">
        {formatSize(file.size)}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 rounded"
          onClick={onReference}
          title={t('sidebar.files.reference')}
        >
          <CornerDownLeft className="h-3 w-3" />
        </Button>
        {previewable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 rounded"
            onClick={onPreview}
            title={t('sidebar.files.preview')}
          >
            <Eye className="h-3 w-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 rounded"
          onClick={onDownload}
          title={t('sidebar.files.download')}
        >
          <Download className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

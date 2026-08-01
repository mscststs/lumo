import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  File,
  Trash2,
  Download,
  Eye,
  Loader2,
  HardDrive,
  FileText,
  Image,
  FileCode,
  MessageSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fileStorage, type FileMetadata, getPreviewCategory } from '@/lib/mcp';
import { storage } from '@/store/storage';
import type { Conversation } from '@/types';

/**
 * Format file size to human-readable string.
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format timestamp to locale date string.
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Get the icon for a file based on its MIME type.
 */
function FileIcon({ mimeType }: { mimeType: string }) {
  const category = getPreviewCategory(mimeType);
  switch (category) {
    case 'image':
      return <Image className="h-4 w-4 text-green-500" />;
    case 'text':
      if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('json')) {
        return <FileCode className="h-4 w-4 text-blue-500" />;
      }
      return <FileText className="h-4 w-4 text-orange-500" />;
    default:
      return <File className="h-4 w-4 text-muted-foreground" />;
  }
}

export function FileManager() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [fileList, convList] = await Promise.all([
        fileStorage.listFiles(),
        storage.getConversations(),
      ]);
      setFiles(fileList);
      setConversations(convList);
    } catch (err) {
      console.error('Failed to load files:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (name: string) => {
    if (!confirm(t('options.files.deleteConfirm'))) return;
    setDeleting(name);
    try {
      await fileStorage.deleteFile(name);
      setFiles((prev) => prev.filter((f) => f.name !== name));
    } catch (err) {
      console.error('Failed to delete file:', err);
    } finally {
      setDeleting(null);
    }
  };

  const handleDownload = async (name: string) => {
    const blob = await fileStorage.readFileAsBlob(name);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePreview = (name: string) => {
    const url = chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`);
    window.open(url, '_blank');
  };

  const getConversationTitle = (conversationId?: string): string | null => {
    if (!conversationId) return null;
    const conv = conversations.find((c) => c.id === conversationId);
    return conv?.title || null;
  };

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground">{t('options.files.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('options.files.description')}</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <File className="h-4 w-4" />
            <span>{t('options.files.totalFiles', { count: files.length })}</span>
          </div>
        </div>
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            <span>{t('options.files.totalSize', { size: formatSize(totalSize) })}</span>
          </div>
        </div>
      </div>

      {/* File List */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          <span>{t('common.loading')}</span>
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <File className="h-10 w-10 mb-3 opacity-50" />
          <p className="text-sm">{t('options.files.noFiles')}</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          {/* Table Header */}
          <div className="grid grid-cols-[1fr_80px_120px_140px_100px] gap-2 p-3 bg-muted/50 text-xs font-medium text-muted-foreground border-b border-border">
            <span>{t('options.files.name')}</span>
            <span>{t('options.files.size')}</span>
            <span>{t('options.files.source')}</span>
            <span>{t('options.files.createdAt')}</span>
            <span className="text-right">{t('options.files.actions')}</span>
          </div>

          {/* File Rows */}
          <div className="divide-y divide-border">
            {files.map((file) => (
              <FileRow
                key={file.name}
                file={file}
                conversationTitle={getConversationTitle(file.conversationId)}
                isDeleting={deleting === file.name}
                onPreview={() => handlePreview(file.name)}
                onDownload={() => handleDownload(file.name)}
                onDelete={() => handleDelete(file.name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  conversationTitle,
  isDeleting,
  onPreview,
  onDownload,
  onDelete,
}: {
  file: FileMetadata;
  conversationTitle: string | null;
  isDeleting: boolean;
  onPreview: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const previewable = getPreviewCategory(file.mimeType) !== 'unsupported';

  return (
    <div className="grid grid-cols-[1fr_80px_120px_140px_100px] gap-2 p-3 items-center hover:bg-accent/30 transition-colors">
      {/* Name */}
      <div className="flex items-center gap-2 min-w-0">
        <FileIcon mimeType={file.mimeType} />
        <span className="text-sm font-medium truncate" title={file.name}>
          {file.name}
        </span>
      </div>

      {/* Size */}
      <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>

      {/* Source */}
      <div className="flex items-center gap-1 min-w-0">
        {conversationTitle ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground truncate" title={conversationTitle}>
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate">{conversationTitle}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('options.files.noConversation')}</span>
        )}
      </div>

      {/* Created At */}
      <span className="text-xs text-muted-foreground">{formatDate(file.createdAt)}</span>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1">
        {previewable && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onPreview} title={t('options.files.preview')}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDownload} title={t('options.files.download')}>
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={isDeleting}
          title={t('options.files.delete')}
        >
          {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

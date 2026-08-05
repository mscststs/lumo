import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
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
  Folder,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fileStorage, type FileMetadata, getPreviewCategory } from '@/lib/mcp';
import { storage } from '@/store/storage';
import { downloadAsZip } from '@/lib/zip-download';
import { SettingsHeader } from './components/SettingsHeader';
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
      return <Image className="h-4 w-4 shrink-0 text-green-500" />;
    case 'text':
      if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('json')) {
        return <FileCode className="h-4 w-4 shrink-0 text-blue-500" />;
      }
      return <FileText className="h-4 w-4 shrink-0 text-orange-500" />;
    default:
      return <File className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

/**
 * Represents either a folder group or a standalone file.
 */
interface FolderGroup {
  type: 'folder';
  prefix: string;
  files: FileMetadata[];
  totalSize: number;
}

interface StandaloneFile {
  type: 'file';
  file: FileMetadata;
}

type FileEntry = FolderGroup | StandaloneFile;

/**
 * Group files by their directory prefix (parts ending with `/`).
 * Files without `/` in their name remain standalone.
 */
function groupFilesByDirectory(files: FileMetadata[]): FileEntry[] {
  const folderMap = new Map<string, FileMetadata[]>();
  const standalone: FileMetadata[] = [];

  for (const file of files) {
    const lastSlash = file.name.lastIndexOf('/');
    if (lastSlash > 0) {
      const prefix = file.name.substring(0, lastSlash + 1);
      const existing = folderMap.get(prefix);
      if (existing) {
        existing.push(file);
      } else {
        folderMap.set(prefix, [file]);
      }
    } else {
      standalone.push(file);
    }
  }

  const entries: FileEntry[] = [];

  // Add folder groups (only group if there are 2+ files in the folder)
  for (const [prefix, groupFiles] of folderMap) {
    if (groupFiles.length >= 2) {
      entries.push({
        type: 'folder',
        prefix,
        files: groupFiles.sort((a, b) => a.name.localeCompare(b.name)),
        totalSize: groupFiles.reduce((sum, f) => sum + f.size, 0),
      });
    } else {
      // Single file in a directory path remains standalone
      standalone.push(...groupFiles);
    }
  }

  // Add standalone files
  for (const file of standalone) {
    entries.push({ type: 'file', file });
  }

  // Sort: folders first (alphabetically), then files (by createdAt desc)
  entries.sort((a, b) => {
    if (a.type === 'folder' && b.type === 'folder') {
      return a.prefix.localeCompare(b.prefix);
    }
    if (a.type === 'folder') return -1;
    if (b.type === 'folder') return 1;
    return b.file.createdAt - a.file.createdAt;
  });

  return entries;
}

export function FileManager() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [downloadingFolder, setDownloadingFolder] = useState<string | null>(null);

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

  const entries = useMemo(() => groupFilesByDirectory(files), [files]);

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

  const handleDeleteFolder = async (prefix: string, folderFiles: FileMetadata[]) => {
    if (!confirm(t('options.files.deleteFolderConfirm', { folder: prefix, count: folderFiles.length }))) return;
    setDeletingFolder(prefix);
    try {
      await Promise.all(folderFiles.map((f) => fileStorage.deleteFile(f.name)));
      const names = new Set(folderFiles.map((f) => f.name));
      setFiles((prev) => prev.filter((f) => !names.has(f.name)));
    } catch (err) {
      console.error('Failed to delete folder:', err);
    } finally {
      setDeletingFolder(null);
    }
  };

  const handleDownload = async (name: string) => {
    const blob = await fileStorage.readFileAsBlob(name);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    // Extract just the filename (strip folder prefix)
    const filename = name.includes('/') ? name.split('/').pop()! : name;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a delay to allow download to start
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleDownloadFolder = async (prefix: string, folderFiles: FileMetadata[]) => {
    setDownloadingFolder(prefix);
    try {
      // Strip trailing slash for zip name, e.g. "assets/" -> "assets.zip"
      const folderName = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      const zipName = `${folderName.replace(/\//g, '_')}.zip`;

      await downloadAsZip(
        folderFiles.map((f) => ({
          name: f.name,
          // Strip the folder prefix so files are at root inside zip
          zipPath: f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name,
        })),
        zipName,
      );
    } catch (err) {
      console.error('Failed to download folder as zip:', err);
    } finally {
      setDownloadingFolder(null);
    }
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
      <SettingsHeader
        title={t('options.files.title')}
        description={t('options.files.description')}
      />

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

          {/* Entries: Folder Groups & Standalone Files */}
          <div className="divide-y divide-border">
            {entries.map((entry) =>
              entry.type === 'folder' ? (
                <FolderGroupRow
                  key={entry.prefix}
                  group={entry}
                  isDeleting={deletingFolder === entry.prefix}
                  isDownloading={downloadingFolder === entry.prefix}
                  deletingFile={deleting}
                  onDownloadFolder={() => handleDownloadFolder(entry.prefix, entry.files)}
                  onDeleteFolder={() => handleDeleteFolder(entry.prefix, entry.files)}
                  onPreview={handlePreview}
                  onDownload={handleDownload}
                  onDelete={handleDelete}
                  getConversationTitle={getConversationTitle}
                />
              ) : (
                <FileRow
                  key={entry.file.name}
                  file={entry.file}
                  conversationTitle={getConversationTitle(entry.file.conversationId)}
                  isDeleting={deleting === entry.file.name}
                  onPreview={() => handlePreview(entry.file.name)}
                  onDownload={() => handleDownload(entry.file.name)}
                  onDelete={() => handleDelete(entry.file.name)}
                />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FolderGroupRow({
  group,
  isDeleting,
  isDownloading,
  deletingFile,
  onDownloadFolder,
  onDeleteFolder,
  onPreview,
  onDownload,
  onDelete,
  getConversationTitle,
}: {
  group: FolderGroup;
  isDeleting: boolean;
  isDownloading: boolean;
  deletingFile: string | null;
  onDownloadFolder: () => void;
  onDeleteFolder: () => void;
  onPreview: (name: string) => void;
  onDownload: (name: string) => void;
  onDelete: (name: string) => void;
  getConversationTitle: (conversationId?: string) => string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      {/* Folder Header */}
      <div
        className="grid grid-cols-[1fr_80px_120px_140px_100px] gap-2 p-3 items-center bg-muted/30 hover:bg-accent/30 transition-colors cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Folder Name */}
        <div className="flex items-center gap-2 min-w-0">
          <motion.div
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="shrink-0"
          >
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </motion.div>
          <Folder className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-sm font-medium truncate" title={group.prefix}>
            {group.prefix}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            ({t('options.files.fileCount', { count: group.files.length })})
          </span>
        </div>

        {/* Size */}
        <span className="text-xs text-muted-foreground">{formatSize(group.totalSize)}</span>

        {/* Source - empty for folder row */}
        <span />

        {/* Created At - empty for folder row */}
        <span />

        {/* Actions */}
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDownloadFolder}
            disabled={isDownloading}
            title={t('options.files.downloadFolder')}
          >
            {isDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDeleteFolder}
            disabled={isDeleting}
            title={t('options.files.deleteFolder')}
          >
            {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Folder Content (collapsible) */}
      <motion.div
        initial={false}
        animate={{ height: expanded ? 'auto' : 0, opacity: expanded ? 1 : 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="overflow-hidden"
      >
        <div className="border-t border-border/50">
          {group.files.map((file) => (
            <FileRow
              key={file.name}
              file={file}
              conversationTitle={getConversationTitle(file.conversationId)}
              isDeleting={deletingFile === file.name}
              onPreview={() => onPreview(file.name)}
              onDownload={() => onDownload(file.name)}
              onDelete={() => onDelete(file.name)}
              indent
              folderPrefix={group.prefix}
            />
          ))}
        </div>
      </motion.div>
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
  indent = false,
  folderPrefix,
}: {
  file: FileMetadata;
  conversationTitle: string | null;
  isDeleting: boolean;
  onPreview: () => void;
  onDownload: () => void;
  onDelete: () => void;
  indent?: boolean;
  folderPrefix?: string;
}) {
  const { t } = useTranslation();
  const previewable = getPreviewCategory(file.mimeType) !== 'unsupported';

  // Display name: strip the folder prefix if inside a folder group
  const displayName = folderPrefix && file.name.startsWith(folderPrefix)
    ? file.name.slice(folderPrefix.length)
    : file.name;

  return (
    <div className={`grid grid-cols-[1fr_80px_120px_140px_100px] gap-2 p-3 items-center hover:bg-accent/30 transition-colors ${indent ? 'pl-10' : ''}`}>
      {/* Name */}
      <div className="flex items-center gap-2 min-w-0">
        <FileIcon mimeType={file.mimeType} />
        <span className="text-sm font-medium truncate" title={file.name}>
          {displayName}
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

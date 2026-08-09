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
import { setFileRefDragData } from '@/lib/file-drag';
import { hasOsFiles, importTextFiles } from '@/lib/file-import';
import { useSidePanelPresence } from '@/lib/side-panel-presence';
import { useEvent } from '@/lib/event-bus';
import { listConversationMeta, type ConversationMeta } from '@/lib/conversation-store';
import { downloadAsZip } from '@/lib/zip-download';
import { formatBytes } from '@/lib/utils';
import { SettingsHeader } from './components/SettingsHeader';

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
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [downloadingFolder, setDownloadingFolder] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  /**
   * Dragging a row into the side panel only works while a panel is open, so the
   * rows stop advertising a gesture that would end nowhere. Presence that cannot
   * be detected leaves them draggable — a failed probe must not cost the feature.
   */
  const canDragToSidePanel = useSidePanelPresence() !== false;

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [fileList, convList] = await Promise.all([
        fileStorage.listFiles(),
        // Summaries only — this view needs titles, never message bodies.
        listConversationMeta(),
      ]);
      setFiles(fileList);
      setConversations(convList);
    } catch (err) {
      console.error('Failed to load files:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Live updates from other contexts.
   *
   * The list was loaded once on mount, so a file an agent wrote after this tab
   * was opened never appeared. Reloads are silent: a full-list refresh must not
   * replace the table with a spinner while the user is reading it.
   */
  useEvent('files:changed', () => {
    void refresh(true);
  });

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

  /**
   * Dropping files from the OS is the "uploaded manually" half of what this view
   * claims to manage — until now the only way in was an agent's `file_write`, and
   * a file dragged onto the page just navigated the tab to it.
   *
   * The surface is deliberately the whole pane rather than the card: the card is
   * capped at `max-w-4xl` and is short when there are few files, so most of what
   * looks like this view would otherwise still be live browser drop area, and
   * missing the card by a few pixels would replace the settings page with the
   * dropped file. The highlight stays on the card, which is where the file lands.
   *
   * The `hasOsFiles` guard matters: this view is itself a drag *source* (every row
   * is draggable), so without it, dragging a row across the table would light the
   * pane up as a drop target for a payload it would then refuse.
   *
   * No `conversationId` is passed — there is no conversation here, so these rows
   * read as "Manual / Unknown", which is what the source column already says for
   * a file with no chat behind it. Nothing else is needed to refresh the list:
   * `writeFile` announces itself and the `files:changed` handler above reloads.
   */
  const handleDragOver = (e: React.DragEvent) => {
    if (!hasOsFiles(e.dataTransfer)) return;
    // Both events are cancelled: the spec accepts either, but only cancelling
    // `dragover` leaves Firefox refusing the drop.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only the pane's own boundary; crossing into a row is not a leave.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!hasOsFiles(e.dataTransfer)) return;
    e.preventDefault();
    setIsDragOver(false);
    void importTextFiles(e.dataTransfer.files);
  };

  const getConversationTitle = (conversationId?: string): string | null => {
    if (!conversationId) return null;
    const conv = conversations.find((c) => c.id === conversationId);
    return conv?.title || null;
  };

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div
      className="min-h-full"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`max-w-4xl rounded-lg ${
          isDragOver ? 'outline-2 outline-dashed outline-offset-4 outline-chat-user/60' : ''
        }`}
      >
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
              <span>{t('options.files.totalSize', { size: formatBytes(totalSize) })}</span>
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
                    canDragToSidePanel={canDragToSidePanel}
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
                    canDragToSidePanel={canDragToSidePanel}
                  />
                ),
              )}
            </div>
          </div>
        )}
      </div>
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
  canDragToSidePanel,
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
  canDragToSidePanel: boolean;
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
        <span className="text-xs text-muted-foreground">{formatBytes(group.totalSize)}</span>

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
              canDragToSidePanel={canDragToSidePanel}
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
  canDragToSidePanel,
}: {
  file: FileMetadata;
  conversationTitle: string | null;
  isDeleting: boolean;
  onPreview: () => void;
  onDownload: () => void;
  onDelete: () => void;
  indent?: boolean;
  folderPrefix?: string;
  canDragToSidePanel: boolean;
}) {
  const { t } = useTranslation();
  const previewable = getPreviewCategory(file.mimeType) !== 'unsupported';

  // Display name: strip the folder prefix if inside a folder group
  const displayName = folderPrefix && file.name.startsWith(folderPrefix)
    ? file.name.slice(folderPrefix.length)
    : file.name;

  /**
   * The row itself is the drag handle — dragging it into an open side panel adds
   * the file as a reference chip. A dedicated grip icon was deliberately not
   * added: the row already carries its action buttons, and the side panel's own
   * file list is picked up the same way, so the gesture is the one users know.
   */
  const handleDragStart = (e: React.DragEvent) => {
    setFileRefDragData(e.dataTransfer, file.name);
  };

  return (
    <div
      className={`grid grid-cols-[1fr_80px_120px_140px_100px] gap-2 p-3 items-center hover:bg-accent/30 transition-colors ${canDragToSidePanel ? 'active:cursor-grabbing' : ''} ${indent ? 'pl-10' : ''}`}
      draggable={canDragToSidePanel}
      onDragStart={handleDragStart}
      title={canDragToSidePanel ? t('options.files.dragHint') : undefined}
    >
      {/* Name */}
      <div className="flex items-center gap-2 min-w-0">
        <FileIcon mimeType={file.mimeType} />
        <span className="text-sm font-medium truncate" title={file.name}>
          {displayName}
        </span>
      </div>

      {/* Size */}
      <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>

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

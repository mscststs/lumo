import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, File, Loader2, MessageSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clearConversations } from '@/lib/conversation-store';
import { fileStorage } from '@/lib/mcp/file-storage';
import { localPanelStorage, resetPanelConversations } from '@/lib/panel-storage';
import { formatBytes } from '@/lib/utils';
import { storage } from '@/store/storage';
import type { StorageUsageReport } from '@/lib/storage-usage';
import type { UseStorageUsageReturn } from './useStorageUsage';

/** Which clear action is in flight, if any. */
type Clearing = 'chat' | 'files' | null;

/**
 * What Lumo has stored, and the two ways to reclaim it.
 *
 * One row per thing the user recognises — their chats and their files — rather
 * than one per store: screenshots live in a store of their own but are created
 * and deleted with the conversation that produced them, so they are counted into
 * the chat-history line instead of implying a third decision. Settings are not
 * shown at all; they are bounded by design and are never what fills a disk.
 *
 * The browser's own origin estimate is shown last, as a bar. It is always larger
 * than the rows above it (index and database overhead, plus the caches the
 * extension pages themselves use), so it reads as context for the quota rather
 * than as a total to reconcile.
 */
export function StorageUsageCard({ report, loading, refresh }: UseStorageUsageReturn) {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState<Clearing>(null);

  const handleClearChat = async () => {
    if (!confirm(t('options.about.storage.clearChatConfirm'))) return;
    setClearing('chat');
    try {
      await clearConversations();
      // Panels keep a pointer to the conversation they had open; left alone it
      // would name a conversation that no longer exists.
      await resetPanelConversations(localPanelStorage);
      // Last, so every other context re-reads a database that has already
      // settled rather than one mid-cleanup.
      await storage.bumpConversationsRevision();
      await refresh(true);
    } catch (error) {
      console.error('Failed to clear chat history:', error);
    } finally {
      setClearing(null);
    }
  };

  const handleClearFiles = async () => {
    const count = report?.files.count ?? 0;
    if (!confirm(t('options.about.storage.clearFilesConfirm', { count }))) return;
    setClearing('files');
    try {
      await fileStorage.clearFiles();
      // Explicit rather than leaning on the `files:changed` refresh: clearing an
      // already-empty store announces nothing, and the button must still settle.
      await refresh(true);
    } catch (error) {
      console.error('Failed to clear stored files:', error);
    } finally {
      setClearing(null);
    }
  };

  if (!report) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  const hasChatData = report.conversations.count > 0 || report.screenshots.count > 0;
  // Screenshots are part of what "clear history" deletes, so they are part of
  // what it is worth reporting as the cost of keeping it.
  const chatBytes = report.conversations.bytes + report.screenshots.bytes;

  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      <UsageRow
        icon={<MessageSquare className="h-4 w-4" />}
        label={t('options.about.storage.conversations')}
        detail={t('options.about.storage.conversationsCount', {
          count: report.conversations.count,
        })}
        bytes={chatBytes}
        dimmed={loading}
        action={
          <ClearButton
            label={t('options.about.storage.clearChat')}
            busy={clearing === 'chat'}
            disabled={clearing !== null || !hasChatData}
            onClick={handleClearChat}
          />
        }
      />
      <UsageRow
        icon={<File className="h-4 w-4" />}
        label={t('options.about.storage.files')}
        detail={t('options.about.storage.filesCount', { count: report.files.count })}
        bytes={report.files.bytes}
        dimmed={loading}
        action={
          <ClearButton
            label={t('options.about.storage.clearFiles')}
            busy={clearing === 'files'}
            disabled={clearing !== null || report.files.count === 0}
            onClick={handleClearFiles}
          />
        }
      />
      <OriginQuota origin={report.origin} />
    </div>
  );
}

function UsageRow({
  icon,
  label,
  detail,
  bytes,
  action,
  dimmed,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  bytes: number;
  action?: React.ReactNode;
  /** True while a re-measure is in flight, so stale numbers read as stale. */
  dimmed?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{label}</div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      <span
        className={`shrink-0 text-sm font-medium tabular-nums transition-opacity ${
          dimmed ? 'opacity-50' : ''
        }`}
      >
        {formatBytes(bytes)}
      </span>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * The browser's allowance for this origin.
 *
 * Hidden entirely when `navigator.storage.estimate()` is unavailable — a bar
 * pinned at zero would claim nothing is stored, which is the opposite of what
 * "cannot tell" means.
 */
function OriginQuota({ origin }: { origin: StorageUsageReport['origin'] }) {
  const { t } = useTranslation();
  if (!origin || origin.quota === 0) return null;

  const percent = (origin.usage / origin.quota) * 100;

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Database className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('options.about.storage.origin')}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {t('options.about.storage.originUsage', {
            usage: formatBytes(origin.usage),
            quota: formatBytes(origin.quota),
          })}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          // Floored at a hairline so a small-but-nonzero usage is still visible.
          style={{ width: `${percent > 0 ? Math.max(percent, 1) : 0}%` }}
        />
      </div>
    </div>
  );
}

function ClearButton({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Trash2 className="h-3.5 w-3.5" />
      )}
      {/* The icon carries the action on narrow panes; the words appear when
          there is room for them. */}
      <span className="ml-2 hidden truncate lg:inline">{label}</span>
    </Button>
  );
}

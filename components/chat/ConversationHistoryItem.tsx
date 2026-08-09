import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { conversationTitle } from '@/lib/conversation-title';
import { useRelativeTime } from '@/lib/use-relative-time';
import type { ConversationMeta } from '@/lib/conversation-store';

interface ConversationHistoryItemProps {
  conversation: ConversationMeta;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ConversationHistoryItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
}: ConversationHistoryItemProps) {
  const { t } = useTranslation();
  const formatRelative = useRelativeTime();
  // Inline confirmation instead of window.confirm, which is unavailable in some
  // extension surfaces and jarring inside a narrow side panel.
  const [isConfirming, setIsConfirming] = useState(false);

  // Precomputed when the conversation was saved, so rendering the list never
  // touches message bodies.
  const preview = conversation.preview;

  return (
    <div
      className={cn(
        'group relative rounded-lg border border-transparent transition-colors',
        isActive ? 'bg-muted' : 'hover:bg-muted/60',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(conversation.id)}
        className="w-full text-left px-2.5 py-2 min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-lg"
      >
        {/* pr leaves room for the hover actions so long titles never sit under them */}
        <div className="flex items-baseline justify-between gap-2 pr-7">
          <span className="text-xs font-medium truncate min-w-0">
            {conversationTitle(conversation.title, t)}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
            {formatRelative(conversation.updatedAt)}
          </span>
        </div>
        {preview && (
          <p className="text-[11px] text-muted-foreground truncate mt-0.5 pr-7">{preview}</p>
        )}
      </button>

      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {isConfirming ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              onClick={() => onDelete(conversation.id)}
              title={t('common.confirm')}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground"
              onClick={() => setIsConfirming(false)}
              title={t('common.cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:text-destructive"
            onClick={() => setIsConfirming(true)}
            title={t('common.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

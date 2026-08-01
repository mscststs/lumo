import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { X, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConversationHistoryItem } from './ConversationHistoryItem';
import { extractText, normalizeMessage } from '@/lib/message-parts';
import type { Conversation } from '@/types';

interface ConversationHistoryProps {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (conversation: Conversation) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}

export function ConversationHistory({
  conversations,
  currentId,
  onSelect,
  onDelete,
  onClearAll,
  onClose,
}: ConversationHistoryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((conversation) => {
      if (conversation.title.toLowerCase().includes(needle)) return true;
      return conversation.messages.some((message) =>
        extractText(normalizeMessage(message)).toLowerCase().includes(needle),
      );
    });
  }, [sorted, query]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="absolute inset-0 z-20 flex flex-col bg-background"
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold truncate min-w-0 flex-1">
          {t('sidebar.history.title')}
        </span>
        {conversations.length > 0 &&
          (isConfirmingClear ? (
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px] text-destructive hover:text-destructive"
                onClick={() => {
                  onClearAll();
                  setIsConfirmingClear(false);
                }}
              >
                {t('common.confirm')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setIsConfirmingClear(false)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setIsConfirmingClear(true)}
              title={t('sidebar.history.clearAll')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          title={t('common.back')}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      {conversations.length > 0 && (
        <div className="px-3 pt-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sidebar.history.search')}
              className="h-8 text-xs pl-7 bg-muted/50 border-0 shadow-none"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-lumo p-2 space-y-0.5">
        {conversations.length === 0 ? (
          <p className="text-center text-muted-foreground text-xs py-8 px-4">
            {t('sidebar.history.empty')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-muted-foreground text-xs py-8 px-4">
            {t('sidebar.history.noResults')}
          </p>
        ) : (
          filtered.map((conversation) => (
            <ConversationHistoryItem
              key={conversation.id}
              conversation={conversation}
              isActive={conversation.id === currentId}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </motion.div>
  );
}

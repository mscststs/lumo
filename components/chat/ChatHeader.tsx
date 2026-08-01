import { useTranslation } from 'react-i18next';
import { Settings, Plus, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelOption } from '@/store/useModelSelection';

interface ChatHeaderProps {
  currentModelValue: string;
  allModels: ModelOption[];
  onModelChange: (value: string) => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
}

export function ChatHeader({
  currentModelValue,
  allModels,
  onModelChange,
  onNewChat,
  onOpenHistory,
  onOpenSettings,
}: ChatHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
      <Select value={currentModelValue} onValueChange={onModelChange}>
        <SelectTrigger className="h-8 text-xs font-medium w-auto min-w-0 mr-2 border-0 bg-transparent px-1.5 py-1 shadow-none hover:bg-muted/60 rounded-md transition-colors gap-1">
          <SelectValue placeholder={t('sidebar.selectModel')} />
        </SelectTrigger>
        <SelectContent>
          {allModels.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onNewChat}
          title={t('sidebar.newChat')}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onOpenHistory}
          title={t('sidebar.history.title')}
        >
          <History className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onOpenSettings}
          title={t('sidebar.settings')}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}

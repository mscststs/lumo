import { useTranslation } from 'react-i18next';
import { Settings, Plus, History, PanelLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { ModelOption } from '@/store/useModelSelection';
import type { ProviderConfig } from '@/types';

interface ChatHeaderProps {
  currentModelValue: string;
  allModels: ModelOption[];
  providers: ProviderConfig[];
  onModelChange: (value: string) => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onOpenSettings?: () => void;
  onClose?: () => void;
  showSplitButton?: boolean;
  onSplit?: () => void;
  /**
   * Begins a panel reorder drag. Absent when there is nothing to reorder.
   *
   * There is no separate handle: the header itself is the drag surface, so the
   * gesture has no visual affordance of its own.
   */
  onReorderPointerDown?: (event: React.PointerEvent) => void;
  /** Whether this panel is currently being dragged, for cursor feedback. */
  isDragging?: boolean;
}

export function ChatHeader({
  currentModelValue,
  allModels,
  providers,
  onModelChange,
  onNewChat,
  onOpenHistory,
  onOpenSettings,
  onClose,
  showSplitButton,
  onSplit,
  onReorderPointerDown,
  isDragging,
}: ChatHeaderProps) {
  const { t } = useTranslation();

  /**
   * Starts a drag from anywhere on the header that is not itself interactive.
   *
   * The whole header is the drag surface. Interactive descendants are excluded by
   * hit-testing the event target rather than by reserving a dedicated strip: a
   * spacer would be squeezed to zero width in a narrow side panel and the drag
   * surface would vanish exactly when it is hardest to hit.
   */
  const handleHeaderPointerDown = (event: React.PointerEvent) => {
    if (!onReorderPointerDown) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,[role="combobox"],a,input,textarea,[data-no-drag]')) return;
    onReorderPointerDown(event);
  };

  const isReorderable = Boolean(onReorderPointerDown);

  return (
    <header
      className={cn(
        'flex items-center justify-between px-3 py-2 border-b border-border shrink-0',
        // `touch-none` stops the browser claiming the gesture as a scroll before
        // the pointer handler sees it.
        isReorderable && 'touch-none',
        // Suppress text selection only while dragging, so a header is still
        // selectable at rest.
        isDragging && 'cursor-grabbing select-none',
      )}
      onPointerDown={handleHeaderPointerDown}
    >
      <div className="flex items-center min-w-0">
        {showSplitButton && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 mr-1"
            onClick={onSplit}
            title={t('sidebar.splitWindow')}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        )}
        <Select value={currentModelValue} onValueChange={onModelChange}>
          <SelectTrigger className="h-8 text-xs font-medium w-auto min-w-0 mr-2 border-0 bg-transparent px-1.5 py-1 shadow-none hover:bg-muted/60 rounded-md transition-colors gap-1">
            <SelectValue placeholder={t('sidebar.selectModel')} />
          </SelectTrigger>
          <SelectContent className="min-w-[13rem] font-mono">
            {providers.map((p) => {
              const models = allModels.filter((m) => m.value.startsWith(`${p.id}::`));
              if (models.length === 0) return null;
              return (
                <SelectGroup key={p.id}>
                  <SelectLabel>{p.name}</SelectLabel>
                  {models.map((m) => (
                    <SelectItem key={m.value} value={m.value} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
      </div>
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
        {onOpenSettings && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onOpenSettings}
            title={t('sidebar.settings')}
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            title={t('sidebar.closePanel')}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </header>
  );
}

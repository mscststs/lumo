import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isToolUIPart } from 'ai';
import { AnimatePresence, motion } from 'motion/react';
import {
  MessageSquare,
  Bot,
  User,
  Wrench,
  ChevronDown,
  FileText,
  Brain,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { normalizeMessage, toolPartName } from '@/lib/message-parts';
import { panelConversationKey } from '@/lib/panel-storage';
import { safeStringify } from '@/lib/tool-output';
import type { Conversation, ChatMessage, ChatMessagePart } from '@/types';
import { SettingsHeader } from './components/SettingsHeader';
import type { ToolPart } from '@/lib/message-parts';

/** Storage key for the actual visible panel count */
const VISIBLE_PANELS_KEY = 'splitView_visiblePanelCount';

/**
 * Debug entry representing one logical "card" in the timeline.
 * We flatten a conversation's messages + parts into these entries
 * so tool calls are properly separated from text segments.
 */
interface DebugEntry {
  id: string;
  timestamp: number;
  type: 'system-prompt' | 'user' | 'assistant-text' | 'assistant-reasoning' | 'tool-call';
  /** The raw text content (for text/reasoning/system-prompt) */
  content?: string;
  /** For tool-call entries */
  toolPart?: ToolPart;
  /** For file parts */
  fileUrl?: string;
  fileMediaType?: string;
}

/**
 * Flatten a conversation into a linear timeline of debug entries.
 * Text chunks between tool calls are merged into single entries,
 * but tool calls always create their own entry.
 */
function buildTimeline(conversation: Conversation): DebugEntry[] {
  const entries: DebugEntry[] = [];

  // System prompt entry
  if (conversation.systemPrompt) {
    entries.push({
      id: `${conversation.id}-system`,
      timestamp: conversation.createdAt,
      type: 'system-prompt',
      content: conversation.systemPrompt,
    });
  }

  for (const message of conversation.messages) {
    const parts = normalizeMessage(message);

    if (message.role === 'user') {
      // Merge all user text parts into one entry
      const textParts = parts.filter(
        (p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text',
      );
      const fileParts = parts.filter(
        (p): p is Extract<ChatMessagePart, { type: 'file' }> => p.type === 'file',
      );

      const content = textParts.map((p) => p.text).join('');
      entries.push({
        id: message.id,
        timestamp: message.timestamp,
        type: 'user',
        content: content || (fileParts.length > 0 ? `[${fileParts.length} file(s)]` : ''),
        fileUrl: fileParts[0]?.url,
        fileMediaType: fileParts[0]?.mediaType,
      });
    } else {
      // Assistant: split by tool calls
      let pendingText = '';
      let pendingReasoning = '';
      let textIdx = 0;
      let reasoningIdx = 0;

      const flushText = () => {
        if (pendingText) {
          entries.push({
            id: `${message.id}-text-${textIdx}`,
            timestamp: message.timestamp,
            type: 'assistant-text',
            content: pendingText,
          });
          pendingText = '';
          textIdx++;
        }
      };

      const flushReasoning = () => {
        if (pendingReasoning) {
          entries.push({
            id: `${message.id}-reasoning-${reasoningIdx}`,
            timestamp: message.timestamp,
            type: 'assistant-reasoning',
            content: pendingReasoning,
          });
          pendingReasoning = '';
          reasoningIdx++;
        }
      };

      for (const part of parts) {
        if (part.type === 'text') {
          flushReasoning();
          pendingText += part.text;
        } else if (part.type === 'reasoning') {
          flushText();
          pendingReasoning += part.text;
        } else if (isToolUIPart(part)) {
          flushText();
          flushReasoning();
          entries.push({
            id: `${message.id}-tool-${(part as ToolPart).toolCallId}`,
            timestamp: message.timestamp,
            type: 'tool-call',
            toolPart: part as ToolPart,
          });
        }
        // skip step-start and file parts on assistant side for now
      }

      flushText();
      flushReasoning();
    }
  }

  return entries;
}

export function ChatDebugPage() {
  const { t } = useTranslation();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [visiblePanelCount, setVisiblePanelCount] = useState(1);
  const [selectedPanel, setSelectedPanel] = useState(0);

  // Load visible panel count on mount
  useEffect(() => {
    chrome.storage.local.get(VISIBLE_PANELS_KEY).then((result) => {
      const count = (result[VISIBLE_PANELS_KEY] as number | undefined) ?? 1;
      setVisiblePanelCount(count);
    });
  }, []);

  // Watch for visible panel count changes
  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (VISIBLE_PANELS_KEY in changes) {
        const newCount = changes[VISIBLE_PANELS_KEY]?.newValue as number | undefined;
        if (newCount && newCount >= 1) {
          setVisiblePanelCount(newCount);
          if (selectedPanel >= newCount) {
            setSelectedPanel(0);
          }
        }
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [selectedPanel]);

  // Load conversation when selected panel changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const convKey = panelConversationKey(selectedPanel);
      const convResult = await chrome.storage.local.get(convKey);
      const currentId = convResult[convKey] as string | null | undefined;
      if (cancelled) return;

      if (!currentId) {
        setConversation(null);
        setLoading(false);
        return;
      }
      const conversations = await storage.getConversations();
      if (cancelled) return;
      setConversation(conversations.find((c) => c.id === currentId) ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedPanel]);

  // Watch for changes to conversations (live updates while streaming)
  useStorageWatch<Conversation[]>(
    'conversations',
    useCallback((newConversations) => {
      if (!newConversations) return;
      const convKey = panelConversationKey(selectedPanel);
      chrome.storage.local.get(convKey).then((result) => {
        const currentId = result[convKey] as string | null | undefined;
        if (!currentId) {
          setConversation(null);
          return;
        }
        setConversation(newConversations.find((c) => c.id === currentId) ?? null);
      });
    }, [selectedPanel]),
  );

  // Watch for the selected panel's currentConversationId changes
  useEffect(() => {
    const convKey = panelConversationKey(selectedPanel);
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (convKey in changes) {
        const newId = changes[convKey]?.newValue as string | null | undefined;
        if (!newId) {
          setConversation(null);
          return;
        }
        storage.getConversations().then((conversations) => {
          setConversation(conversations.find((c) => c.id === newId) ?? null);
        });
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [selectedPanel]);

  const getPanelSideLabel = (panelId: number): string => {
    if (visiblePanelCount <= 1) return t('options.chatDebug.panelRight');
    if (visiblePanelCount === 2) {
      return panelId === 0 ? t('options.chatDebug.panelRight') : t('options.chatDebug.panelLeft');
    }
    if (panelId === 0) return t('options.chatDebug.panelRight');
    if (panelId === 1) return t('options.chatDebug.panelMiddle');
    return t('options.chatDebug.panelLeft');
  };

  const timeline = useMemo(
    () => (conversation ? buildTimeline(conversation) : []),
    [conversation],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-muted-foreground">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <SettingsHeader
        title={t('options.chatDebug.title')}
        description={t('options.chatDebug.description')}
        className="mb-0"
      />

      {/* Panel switcher (only show when multiple panels visible) */}
      {visiblePanelCount > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0">{t('options.chatDebug.panelSelect')}</span>
          <div className="flex gap-1">
            {Array.from({ length: visiblePanelCount }, (_, i) => visiblePanelCount - 1 - i).map((panelId) => (
              <Button
                key={panelId}
                variant={selectedPanel === panelId ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setSelectedPanel(panelId)}
              >
                {getPanelSideLabel(panelId)}
              </Button>
            ))}
          </div>
        </div>
      )}

      {!conversation ? (
        <EmptyState />
      ) : (
        <>
          {/* Conversation meta */}
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{conversation.title}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{conversation.providerId} / {conversation.modelId}</span>
              <span>{new Date(conversation.createdAt).toLocaleString()}</span>
              <span>{conversation.messages.length} messages</span>
            </div>
            <p className="text-xs text-muted-foreground/70">{t('options.chatDebug.refreshHint')}</p>
          </div>

          {/* Timeline */}
          <div className="space-y-2">
            {timeline.map((entry) => (
              <DebugCard key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center space-y-3">
      <MessageSquare className="h-10 w-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground max-w-xs">
        {t('options.chatDebug.noConversation')}
      </p>
    </div>
  );
}

// ─── Debug Card ─────────────────────────────────────────────────────────────────

const ENTRY_STYLES: Record<DebugEntry['type'], { icon: React.ElementType; label: string; borderClass: string }> = {
  'system-prompt': { icon: FileText, label: 'options.chatDebug.systemPrompt', borderClass: 'border-l-purple-500' },
  'user': { icon: User, label: 'options.chatDebug.userMessage', borderClass: 'border-l-blue-500' },
  'assistant-text': { icon: Bot, label: 'options.chatDebug.assistantMessage', borderClass: 'border-l-green-500' },
  'assistant-reasoning': { icon: Brain, label: 'options.chatDebug.reasoningPart', borderClass: 'border-l-amber-500' },
  'tool-call': { icon: Wrench, label: 'options.chatDebug.toolCall', borderClass: 'border-l-orange-500' },
};

function DebugCard({ entry }: { entry: DebugEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const style = ENTRY_STYLES[entry.type];
  const Icon = style.icon;

  const isToolCall = entry.type === 'tool-call' && entry.toolPart;

  // Determine preview content (3-5 lines)
  const previewContent = useMemo(() => {
    if (isToolCall && entry.toolPart) {
      return `${toolPartName(entry.toolPart)} → ${entry.toolPart.state}`;
    }
    return entry.content ?? '';
  }, [entry, isToolCall]);

  const needsExpand = useMemo(() => {
    if (isToolCall) return true; // Tool calls always have more detail
    const lineCount = (previewContent.match(/\n/g) || []).length + 1;
    return lineCount > 4 || previewContent.length > 300;
  }, [previewContent, isToolCall]);

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card overflow-hidden border-l-4 transition-colors',
        style.borderClass,
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground truncate">
          {t(style.label)}
          {isToolCall && entry.toolPart && (
            <span className="ml-1 font-mono text-muted-foreground">
              {toolPartName(entry.toolPart)}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <Clock className="h-3 w-3 text-muted-foreground/60" />
          <span className="text-[0.625rem] text-muted-foreground/70 tabular-nums">
            {formatTime(entry.timestamp)}
          </span>
          {needsExpand && (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                expanded && 'rotate-180',
              )}
            />
          )}
        </span>
      </button>

      {/* Content */}
      <div className="px-3 pb-2">
        {isToolCall && entry.toolPart ? (
          <ToolCallContent part={entry.toolPart} expanded={expanded} />
        ) : (
          <TextContent content={previewContent} expanded={expanded} needsExpand={needsExpand} />
        )}
      </div>
    </div>
  );
}

function TextContent({
  content,
  expanded,
  needsExpand,
}: {
  content: string;
  expanded: boolean;
  needsExpand: boolean;
}) {
  if (!content) return null;

  return (
    <div className="relative">
      <pre
        className={cn(
          'text-xs font-mono whitespace-pre-wrap break-all text-foreground/80 leading-relaxed',
          !expanded && needsExpand && 'line-clamp-4',
        )}
      >
        {content}
      </pre>
      {!expanded && needsExpand && (
        <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-card to-transparent pointer-events-none" />
      )}
    </div>
  );
}

function ToolCallContent({ part, expanded }: { part: ToolPart; expanded: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {/* Compact preview when collapsed */}
      {!expanded && (
        <div className="text-xs text-muted-foreground font-mono truncate">
          {part.state === 'output-error'
            ? `Error: ${part.errorText ?? t('options.chatDebug.noContent')}`
            : summarizeInput(part.input)}
        </div>
      )}

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden space-y-2"
          >
            {/* Input */}
            <div className="space-y-1">
              <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('options.chatDebug.input')}
              </div>
              <pre className="max-h-60 overflow-auto scrollbar-lumo rounded-md bg-background border border-border/60 p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                {part.input != null ? safeStringify(part.input) : t('options.chatDebug.noContent')}
              </pre>
            </div>

            {/* Output */}
            {(part.state === 'output-available' || part.state === 'output-error') && (
              <div className="space-y-1">
                <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t('options.chatDebug.output')}
                </div>
                {part.state === 'output-error' ? (
                  <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span className="break-words min-w-0">{part.errorText ?? t('options.chatDebug.noContent')}</span>
                  </div>
                ) : (
                  <pre className="max-h-60 overflow-auto scrollbar-lumo rounded-md bg-background border border-border/60 p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                    {part.output != null ? safeStringify(part.output) : t('options.chatDebug.noContent')}
                  </pre>
                )}
              </div>
            )}

            {/* State badge */}
            <div className="flex items-center gap-1.5">
              <span className="text-[0.625rem] text-muted-foreground/70">State:</span>
              <span className={cn(
                'text-[0.625rem] font-mono px-1.5 py-0.5 rounded',
                part.state === 'output-available' && 'bg-green-500/10 text-green-600 dark:text-green-400',
                part.state === 'output-error' && 'bg-destructive/10 text-destructive',
                part.state === 'input-available' && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
                part.state === 'input-streaming' && 'bg-muted text-muted-foreground',
              )}>
                {part.state}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function summarizeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return '{}';
  return entries
    .slice(0, 3)
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string'
          ? value.length > 30 ? `"${value.slice(0, 30)}…"` : `"${value}"`
          : Array.isArray(value)
            ? `[${value.length}]`
            : typeof value === 'object'
              ? '{…}'
              : String(value);
      return `${key}: ${rendered}`;
    })
    .join(', ');
}

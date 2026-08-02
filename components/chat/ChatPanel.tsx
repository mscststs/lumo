import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { v4 as uuidv4 } from 'uuid';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { ConversationFiles } from '@/components/chat/ConversationFiles';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { useModelSelection } from '@/store/useModelSelection';
import { useChatStream } from '@/store/useChatStream';
import type { TextAttachment, Conversation } from '@/types';
import type { ContextMenuPendingData } from '@/lib/context-menu';

export interface ChatPanelProps {
  /** Panel ID: 0 = rightmost (primary), 1 = second from right, 2 = leftmost */
  panelIndex: number;
  /** Whether to show the settings button (only on rightmost panel, panelId=0) */
  showSettings: boolean;
  /** Whether to show the split window button (only on leftmost panel) */
  showSplitButton: boolean;
  /** Whether to show the close button (panels other than panelId=0) */
  showClose: boolean;
  /** Callback when split button is clicked */
  onSplit?: () => void;
  /** Callback when close button is clicked */
  onClose?: () => void;
  /** Callback to open settings */
  onOpenSettings?: () => void;
  /** Currently occupied session IDs by other panels (to prevent sharing) */
  occupiedSessionIds: string[];
  /** Notify parent when this panel's session changes */
  onSessionChange?: (panelIndex: number, sessionId: string | null) => void;
  /** Whether an external drag is happening (from browser or another panel) */
  isExternalDragActive?: boolean;
  /** Callback when something is dropped onto this panel from outside */
  onExternalDrop?: (panelIndex: number, data: ExternalDropData) => void;
}

export interface ExternalDropData {
  type: 'image' | 'text' | 'html';
  content: string;
}

export interface ChatPanelHandle {
  /** Add images to this panel's input */
  addImages: (urls: string[]) => void;
  /** Add a text attachment to this panel's input */
  addTextAttachment: (attachment: TextAttachment) => void;
  /** Focus this panel's input */
  focus: () => void;
  /** Get the current conversation ID */
  getCurrentSessionId: () => string | null;
}

/**
 * A fully independent chat panel with its own conversation state,
 * model selection, history, and input. Used as a child of SplitView.
 */
export function ChatPanel({
  panelIndex,
  showSettings,
  showSplitButton,
  showClose,
  onSplit,
  onClose,
  onOpenSettings,
  occupiedSessionIds,
  onSessionChange,
  isExternalDragActive,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isInternalDrag, setIsInternalDrag] = useState(false);
  const dragCounterRef = useRef(0);

  const {
    currentModelValue,
    allModels,
    getSelectedProvider,
    getSelectedModel,
    isVisionModel,
    handleModelChange,
    loadData,
    selectedProviderId,
    selectedModelId,
  } = useModelSelection({ panelId: panelIndex });

  const {
    conversations,
    currentConversation,
    isHistoryOpen,
    setIsHistoryOpen,
    isStreaming,
    streamingParts,
    chatError,
    isRetrying,
    retryAttempt,
    isStreamingVisible,
    handleSend,
    handleRetry,
    handleStop,
    handleNewChat,
    handleSelectConversation,
    handleDeleteConversation,
    handleClearAllConversations,
  } = useChatStream({ panelId: panelIndex, occupiedSessionIds });

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Context menu pending data (only first panel consumes) ────────────────
  useEffect(() => {
    if (panelIndex !== 0) return;

    const handler = (e: Event) => {
      const pending = (e as CustomEvent<ContextMenuPendingData>).detail;
      if (!pending) return;

      if (pending.type === 'image' && pending.imageUrl) {
        fetch(pending.imageUrl)
          .then((res) => res.blob())
          .then((blob) => {
            const reader = new FileReader();
            reader.onload = (ev) => {
              const dataUrl = ev.target?.result as string;
              chatInputRef.current?.addImages([dataUrl]);
              chatInputRef.current?.focus();
            };
            reader.readAsDataURL(blob);
          })
          .catch(() => {
            const attachment: TextAttachment = {
              id: uuidv4(),
              mediaType: 'text/plain',
              content: pending.imageUrl!,
              preview: pending.imageUrl!.slice(0, 50),
            };
            chatInputRef.current?.addTextAttachment(attachment);
            chatInputRef.current?.focus();
          });
      } else if (pending.text) {
        const attachment: TextAttachment = {
          id: uuidv4(),
          mediaType: 'text/plain',
          content: pending.text,
          preview: pending.text.slice(0, 50),
        };
        chatInputRef.current?.addTextAttachment(attachment);
        chatInputRef.current?.focus();
      }
    };

    window.addEventListener('lumo-context-menu-pending', handler);
    return () => window.removeEventListener('lumo-context-menu-pending', handler);
  }, [panelIndex]);

  // Notify parent when session changes
  useEffect(() => {
    onSessionChange?.(panelIndex, currentConversation?.id ?? null);
  }, [panelIndex, currentConversation?.id, onSessionChange]);

  // ─── Track internal drag origin ──────────────────────────────────────────
  useEffect(() => {
    const handleDragStart = () => { setIsInternalDrag(true); };
    const handleDragEnd = () => { setIsInternalDrag(false); };
    document.addEventListener('dragstart', handleDragStart);
    document.addEventListener('dragend', handleDragEnd);
    return () => {
      document.removeEventListener('dragstart', handleDragStart);
      document.removeEventListener('dragend', handleDragEnd);
    };
  }, []);

  const handleOpenSettings = () => {
    if (onOpenSettings) {
      onOpenSettings();
    } else {
      chrome.runtime.openOptionsPage();
    }
  };

  const onNewChat = () => {
    handleNewChat();
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

  const onSend = (input: string, images: string[], textAttachments: TextAttachment[]) => {
    void handleSend(input, images, textAttachments, getSelectedProvider, getSelectedModel, selectedProviderId, selectedModelId);
  };

  const onRetry = () => {
    handleRetry(getSelectedProvider, getSelectedModel);
  };

  /**
   * Filter conversations that are occupied by other panels
   */
  const filteredConversations = conversations.filter(
    (c) => !occupiedSessionIds.includes(c.id) || c.id === currentConversation?.id,
  );

  /**
   * Wrap handleSelectConversation to prevent selecting occupied sessions
   */
  const handleSelectConversationFiltered = useCallback(
    async (conversation: Conversation) => {
      if (occupiedSessionIds.includes(conversation.id) && conversation.id !== currentConversation?.id) {
        return; // Cannot select a session occupied by another panel
      }
      await handleSelectConversation(conversation);
    },
    [occupiedSessionIds, currentConversation?.id, handleSelectConversation],
  );

  // ─── Drag-and-drop (per panel) ────────────────────────────────────────────

  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isInternalDrag) return;
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, [isInternalDrag]);

  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isInternalDrag) return;
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, [isInternalDrag]);

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handlePanelDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (isInternalDrag) return;

    const dataTransfer = e.dataTransfer;
    const visionEnabled = isVisionModel();

    // Check for image files first
    const files = dataTransfer.files;
    let hasImageFile = false;
    if (visionEnabled) {
      const imageDataUrls: Promise<string>[] = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          hasImageFile = true;
          imageDataUrls.push(
            new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = (ev) => resolve(ev.target?.result as string);
              reader.readAsDataURL(file);
            }),
          );
        }
      }
      if (imageDataUrls.length > 0) {
        void Promise.all(imageDataUrls).then((urls) => {
          chatInputRef.current?.addImages(urls);
        });
      }
    }

    if (hasImageFile) return;

    // Check for dragged images (e.g. img elements from web pages)
    const htmlData = dataTransfer.getData('text/html');
    if (visionEnabled && htmlData) {
      const imgMatch = /<img[^>]+src=["']([^"']+)["']/i.exec(htmlData);
      if (imgMatch?.[1]) {
        const imgSrc = imgMatch[1];
        if (imgSrc.startsWith('data:')) {
          chatInputRef.current?.addImages([imgSrc]);
          return;
        }
        fetch(imgSrc)
          .then((res) => res.blob())
          .then((blob) => {
            if (blob.type.startsWith('image/')) {
              const reader = new FileReader();
              reader.onload = (ev) => {
                chatInputRef.current?.addImages([ev.target?.result as string]);
              };
              reader.readAsDataURL(blob);
            }
          })
          .catch(() => {
            addTextAttachmentFromDrop(htmlData, 'text/html');
          });
        return;
      }
    }

    // Handle text/html content (non-image HTML fragments)
    if (htmlData && htmlData.trim()) {
      addTextAttachmentFromDrop(htmlData, 'text/html');
      return;
    }

    // Handle plain text
    const textData = dataTransfer.getData('text/plain');
    if (textData && textData.trim()) {
      addTextAttachmentFromDrop(textData, 'text/plain');
    }
  }, [isVisionModel, isInternalDrag]);

  const addTextAttachmentFromDrop = (content: string, mediaType: 'text/plain' | 'text/html') => {
    const preview = content.replace(/<[^>]*>/g, '').trim().slice(0, 50);
    const attachment: TextAttachment = {
      id: uuidv4(),
      mediaType,
      content,
      preview: preview || content.slice(0, 50),
    };
    chatInputRef.current?.addTextAttachment(attachment);
  };

  // ─── File reference (from ConversationFiles panel) ────────────────────────

  const addFileReference = useCallback((fileName: string) => {
    const attachment: TextAttachment = {
      id: uuidv4(),
      kind: 'file-ref',
      mediaType: 'text/plain',
      content: `[file: ${fileName}]`,
      preview: fileName,
      label: t('sidebar.files.file'),
    };
    chatInputRef.current?.addTextAttachment(attachment);
    chatInputRef.current?.focus();
  }, [t]);

  const addInternalTextDrop = useCallback((text: string) => {
    addTextAttachmentFromDrop(text, 'text/plain');
    chatInputRef.current?.focus();
  }, []);

  return (
    <div
      className="relative flex flex-col h-full w-full bg-background overflow-hidden"
      onDragEnter={handlePanelDragEnter}
      onDragLeave={handlePanelDragLeave}
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
    >
      {/* Drag overlay */}
      <AnimatePresence>
        {(isDragOver || isExternalDragActive) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: isDragOver ? 1 : 0.5 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-background/60 backdrop-blur-sm border-2 border-dashed border-chat-user/50 rounded-lg pointer-events-none"
          >
            <div className="text-sm text-chat-user font-medium">
              {t('sidebar.dropHere')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isHistoryOpen && (
          <ConversationHistory
            conversations={filteredConversations}
            currentId={currentConversation?.id ?? null}
            onSelect={handleSelectConversationFiltered}
            onDelete={handleDeleteConversation}
            onClearAll={handleClearAllConversations}
            onClose={() => setIsHistoryOpen(false)}
          />
        )}
      </AnimatePresence>

      <ChatHeader
        currentModelValue={currentModelValue}
        allModels={allModels}
        onModelChange={handleModelChange}
        onNewChat={onNewChat}
        onOpenHistory={() => setIsHistoryOpen(true)}
        onOpenSettings={showSettings ? handleOpenSettings : undefined}
        onClose={showClose ? onClose : undefined}
        showSplitButton={showSplitButton}
        onSplit={onSplit}
      />

      <ChatMessageList
        currentConversation={currentConversation}
        isStreaming={isStreaming}
        isStreamingVisible={isStreamingVisible}
        streamingParts={streamingParts}
        chatError={chatError}
        isRetrying={isRetrying}
        retryAttempt={retryAttempt}
        hasModels={allModels.length > 0}
        onRetry={onRetry}
      />

      <ConversationFiles
        conversationId={currentConversation?.id ?? null}
        onReference={addFileReference}
      />

      <ChatInput
        ref={chatInputRef}
        isStreaming={isStreaming}
        isVisionModel={isVisionModel()}
        onSend={onSend}
        onStop={handleStop}
        isInternalDrag={isInternalDrag}
        onInternalFileDrop={addFileReference}
        onInternalTextDrop={addInternalTextDrop}
      />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { v4 as uuidv4 } from 'uuid';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { ThemeInit } from '@/lib/theme';
import { useModelSelection } from '@/store/useModelSelection';
import { useChatStream } from '@/store/useChatStream';
import { CONTEXT_MENU_PENDING_KEY, type ContextMenuPendingData } from '@/lib/context-menu';
import type { TextAttachment } from '@/types';

export default function App() {
  const { t } = useTranslation();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  // Tracks the timestamp of the last consumed context-menu pending data to
  // deduplicate across the initial read and the onChanged listener (and across
  // StrictMode double-mount in dev).
  const lastContextMenuTimestampRef = useRef(0);

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
  } = useModelSelection();

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
  } = useChatStream();

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Context menu pending selection listener ─────────────────────────────
  useEffect(() => {
    const addPendingAttachment = (pending: ContextMenuPendingData) => {
      if (pending.timestamp <= lastContextMenuTimestampRef.current) return;
      lastContextMenuTimestampRef.current = pending.timestamp;

      if (pending.type === 'image' && pending.imageUrl) {
        // Fetch the image and convert to data URL, then add as image attachment
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
            // If fetch fails (e.g. CORS), fall back to adding the URL as text
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

      // Clear the pending data so it's not re-consumed on next open
      void chrome.storage.session.remove(CONTEXT_MENU_PENDING_KEY);
    };

    // Check if there's a pending context menu selection when the panel opens
    const consumePending = async () => {
      try {
        const result = await chrome.storage.session.get(CONTEXT_MENU_PENDING_KEY);
        const pending = result[CONTEXT_MENU_PENDING_KEY] as ContextMenuPendingData | undefined;
        if (pending && Date.now() - pending.timestamp < 30_000) {
          // Small delay to ensure the input ref is mounted
          requestAnimationFrame(() => {
            addPendingAttachment(pending);
          });
        }
      } catch {
        // Ignore errors
      }
    };

    void consumePending();

    // Also listen for new context menu selections while the panel is already open
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      if (CONTEXT_MENU_PENDING_KEY in changes) {
        const pending = changes[CONTEXT_MENU_PENDING_KEY]?.newValue as ContextMenuPendingData | undefined;
        if (pending) {
          addPendingAttachment(pending);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const handleOpenSettings = () => {
    chrome.runtime.openOptionsPage();
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

  // ─── Global drag-and-drop ─────────────────────────────────────────────────

  const handleGlobalDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleGlobalDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleGlobalDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleGlobalDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

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
  }, [isVisionModel]);

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

  return (
    <div
      className="relative flex flex-col h-screen w-full bg-background overflow-hidden"
      onDragEnter={handleGlobalDragEnter}
      onDragLeave={handleGlobalDragLeave}
      onDragOver={handleGlobalDragOver}
      onDrop={handleGlobalDrop}
    >
      <ThemeInit />

      {/* Global drag overlay */}
      <AnimatePresence>
        {isDragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
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
            conversations={conversations}
            currentId={currentConversation?.id ?? null}
            onSelect={handleSelectConversation}
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
        onOpenSettings={handleOpenSettings}
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

      <ChatInput
        ref={chatInputRef}
        isStreaming={isStreaming}
        isVisionModel={isVisionModel()}
        onSend={onSend}
        onStop={handleStop}
      />
    </div>
  );
}

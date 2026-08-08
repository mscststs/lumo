import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
import { classifyDroppedContent } from '@/lib/drop-content';
import { buildPageContextAttachment } from '@/lib/page-context';
import type { QuickActionDelivery } from '@/lib/quick-action-routing';
import type { TextAttachment, Conversation } from '@/types';
import type { ContextMenuPendingData } from '@/lib/context-menu';

export interface ChatPanelProps {
  /**
   * Storage slot — this panel's identity, and the suffix on its storage keys.
   *
   * Deliberately independent of where the panel sits on screen: it must stay
   * constant for the panel's whole lifetime, because the hooks below key their
   * state off it (see `panel-storage.ts`). Position comes in as the role flags.
   */
  panelIndex: number;
  /** Whether to show the settings button (only on the rightmost panel) */
  showSettings: boolean;
  /** Whether to show the split window button (only on the leftmost panel) */
  showSplitButton: boolean;
  /** Whether to show the close button (every panel but the rightmost) */
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
  /** Starts a reorder drag. Absent when there is nothing to reorder. */
  onReorderPointerDown?: (event: React.PointerEvent) => void;
  /** Whether this panel is being dragged, for cursor feedback. */
  isDragging?: boolean;
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
  /**
   * Routing state for quick actions: whether this panel is mid-stream and
   * whether its input already holds something the user would lose.
   */
  getRoutingState: () => { isStreaming: boolean; hasContent: boolean };
  /**
   * Applies a quick action from the right-click menu. `delivery` decides whether
   * the request fires immediately or the prompt is left in the input to edit.
   */
  applyQuickAction: (pending: ContextMenuPendingData, delivery: QuickActionDelivery) => void;
}

/**
 * A fully independent chat panel with its own conversation state,
 * model selection, history, and input. Used as a child of SplitView.
 */
export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel({
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
  onReorderPointerDown,
  isDragging,
}: ChatPanelProps, ref) {
  const { t } = useTranslation();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isInternalDrag, setIsInternalDrag] = useState(false);
  const dragCounterRef = useRef(0);

  const {
    currentModelValue,
    allModels,
    providers,
    isLoaded: isModelLoaded,
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
    streamingMessage,
    chatError,
    isRetrying,
    retryAttempt,
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

  const onSend = useCallback(
    (input: string, images: string[], textAttachments: TextAttachment[]) => {
      void handleSend(input, images, textAttachments, getSelectedProvider, getSelectedModel, selectedProviderId, selectedModelId);
    },
    [handleSend, getSelectedProvider, getSelectedModel, selectedProviderId, selectedModelId],
  );

  /** Resolve a dragged or right-clicked image source (data URL or remote URL) into a data URL. */
  const resolveImageSrc = useCallback(async (src: string): Promise<string | null> => {
    if (src.startsWith('data:')) {
      return src.startsWith('data:image/') ? src : null;
    }
    try {
      const blob = await fetch(src).then((res) => res.blob());
      if (!blob.type.startsWith('image/')) return null;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target?.result as string);
        reader.onerror = () => reject(new Error(`Failed to read image blob from ${src}`));
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }, []);

  // ─── Quick actions from the right-click menu ──────────────────────────────

  /**
   * Builds the attachments a quick action contributes, in the order the model
   * should read them: page identity first (so it knows what it is looking at),
   * then the selected text.
   *
   * The image is resolved separately because it needs an async fetch and only
   * applies to vision models.
   */
  const buildQuickActionAttachments = useCallback(
    (pending: ContextMenuPendingData): TextAttachment[] => {
      const attachments: TextAttachment[] = [
        buildPageContextAttachment(
          uuidv4(),
          pending.pageContext,
          t('sidebar.pageContextAttachment'),
        ),
      ];

      if (pending.text) {
        attachments.push({
          id: uuidv4(),
          mediaType: 'text/plain',
          content: pending.text,
          preview: pending.text.slice(0, 50),
        });
      }

      return attachments;
    },
    [t],
  );

  /**
   * Resolves the action's image into a data URL, or falls back to a text
   * attachment holding the URL when the fetch is blocked by CORS or the model
   * cannot see images.
   */
  const resolveQuickActionImage = useCallback(
    async (
      imageUrl: string,
    ): Promise<{ images: string[]; textAttachments: TextAttachment[] }> => {
      if (isVisionModel()) {
        const dataUrl = await resolveImageSrc(imageUrl);
        if (dataUrl) return { images: [dataUrl], textAttachments: [] };
      }
      // Degrade to the URL as text rather than dropping the payload: the model
      // may still be able to reason about it, and the user sees what happened.
      return {
        images: [],
        textAttachments: [
          {
            id: uuidv4(),
            mediaType: 'text/plain',
            content: imageUrl,
            preview: imageUrl.slice(0, 50),
          },
        ],
      };
    },
    [isVisionModel, resolveImageSrc],
  );

  const runQuickAction = useCallback(
    (pending: ContextMenuPendingData, delivery: QuickActionDelivery) => {
      void (async () => {
        const attachments = buildQuickActionAttachments(pending);
        let images: string[] = [];

        if (pending.type === 'image' && pending.imageUrl) {
          const resolved = await resolveQuickActionImage(pending.imageUrl);
          images = resolved.images;
          attachments.push(...resolved.textAttachments);
        }

        if (delivery === 'send' && pending.prompt) {
          // Routing only picks `send` for an idle panel with an empty input, so
          // there is no draft to merge and `handleSend`'s own guards cover the
          // race where a stream started in between.
          onSend(pending.prompt, images, attachments);
          return;
        }

        if (images.length > 0) chatInputRef.current?.addImages(images);
        for (const attachment of attachments) {
          chatInputRef.current?.addTextAttachment(attachment);
        }
        if (pending.prompt) chatInputRef.current?.prefill(pending.prompt);
        chatInputRef.current?.focus();
      })();
    },
    [buildQuickActionAttachments, resolveQuickActionImage, onSend],
  );

  /**
   * A quick action that arrived before the panel's model selection had loaded.
   *
   * On a cold open the side panel mounts and dispatches the action while its
   * providers are still being read from `chrome.storage`. Acting immediately
   * would hit `handleSend`'s `if (!provider || !model) return` guard and drop the
   * action silently — exactly the bug where picking a menu item with the panel
   * closed only opened the panel. It would also misread `isVisionModel()` as
   * false and downgrade images to plain URLs.
   *
   * So the action is parked here and replayed once the model is known.
   */
  const deferredQuickActionRef = useRef<
    { pending: ContextMenuPendingData; delivery: QuickActionDelivery } | null
  >(null);

  const applyQuickAction = useCallback(
    (pending: ContextMenuPendingData, delivery: QuickActionDelivery) => {
      if (!isModelLoaded) {
        // Last one wins: a newer action supersedes a stale parked one.
        deferredQuickActionRef.current = { pending, delivery };
        return;
      }
      runQuickAction(pending, delivery);
    },
    [isModelLoaded, runQuickAction],
  );

  useEffect(() => {
    if (!isModelLoaded) return;
    const deferred = deferredQuickActionRef.current;
    if (!deferred) return;
    deferredQuickActionRef.current = null;
    runQuickAction(deferred.pending, deferred.delivery);
  }, [isModelLoaded, runQuickAction]);

  useImperativeHandle(ref, () => ({
    addImages: (urls: string[]) => chatInputRef.current?.addImages(urls),
    addTextAttachment: (attachment: TextAttachment) =>
      chatInputRef.current?.addTextAttachment(attachment),
    focus: () => chatInputRef.current?.focus(),
    getCurrentSessionId: () => currentConversation?.id ?? null,
    getRoutingState: () => ({
      isStreaming,
      hasContent: chatInputRef.current?.hasContent() ?? false,
    }),
    applyQuickAction,
  }), [currentConversation?.id, isStreaming, applyQuickAction]);

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
    async (id: string) => {
      if (occupiedSessionIds.includes(id) && id !== currentConversation?.id) {
        return; // Cannot select a session occupied by another panel
      }
      await handleSelectConversation(id);
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

    // Classify the dropped HTML/text into pure text, pure images, or mixed content.
    const htmlData = dataTransfer.getData('text/html');
    const textData = dataTransfer.getData('text/plain');
    const classified = classifyDroppedContent(htmlData, textData);

    switch (classified.type) {
      case 'text':
        if (classified.text?.trim()) {
          addTextAttachmentFromDrop(classified.text, 'text/plain');
        }
        return;

      case 'html':
        // Mixed text + images (or preserved HTML): keep as an HTML attachment.
        if (classified.html?.trim()) {
          addTextAttachmentFromDrop(classified.html, 'text/html');
        }
        return;

      case 'image': {
        // Pure image selection: extract all image sources.
        if (!visionEnabled || !classified.images?.length) {
          // Vision disabled: fall back to an HTML attachment to avoid data loss.
          if (classified.html?.trim()) {
            addTextAttachmentFromDrop(classified.html, 'text/html');
          }
          return;
        }
        void Promise.all(classified.images.map(resolveImageSrc))
          .then((urls) => urls.filter((url): url is string => url !== null))
          .then((urls) => {
            if (urls.length > 0) {
              chatInputRef.current?.addImages(urls);
            } else if (classified.html?.trim()) {
              addTextAttachmentFromDrop(classified.html, 'text/html');
            }
          });
        return;
      }
    }
  }, [isVisionModel, isInternalDrag, resolveImageSrc]);

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

  /**
   * Re-attaches a text attachment dragged from a transcript card into the input.
   * The full attachment round-trips through the drag payload, so `kind`/`label`
   * (e.g. a `page-context` chip) are preserved rather than degrading to text.
   * A fresh id avoids collisions with the card left behind in the transcript.
   */
  const addInternalAttachmentDrop = useCallback((attachment: TextAttachment) => {
    chatInputRef.current?.addTextAttachment({ ...attachment, id: uuidv4() });
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
        providers={providers}
        onModelChange={handleModelChange}
        onNewChat={onNewChat}
        onOpenHistory={() => setIsHistoryOpen(true)}
        onOpenSettings={showSettings ? handleOpenSettings : undefined}
        onClose={showClose ? onClose : undefined}
        showSplitButton={showSplitButton}
        onSplit={onSplit}
        onReorderPointerDown={onReorderPointerDown}
        isDragging={isDragging}
      />

      <ChatMessageList
        currentConversation={currentConversation}
        isStreaming={isStreaming}
        streamingMessage={streamingMessage}
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
        onInternalAttachmentDrop={addInternalAttachmentDrop}
      />
    </div>
  );
});

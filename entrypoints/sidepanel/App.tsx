import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Plus, Send, Square, ImagePlus, X, History } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  Conversation as ConversationContainer,
  ConversationContent,
  ConversationScrollButton,
  useConversationScroll,
} from '@/components/ai-elements/conversation';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { MessagePartList } from '@/components/chat/MessagePartList';
import { ChatError, classifyError, isRetryableError } from '@/components/chat/ChatError';
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { ThemeInit } from '@/lib/theme';
import { chatStream } from '@/lib/ai';
import { storage } from '@/store/storage';
import { useStorageWatchMultiple } from '@/store/useStorageWatch';
import { useConversations } from '@/store/useConversations';
import { hasRenderableParts, toUIMessages } from '@/lib/message-parts';
import { resolveSystemPrompt } from '@/lib/system-prompt';
import type {
  ProviderConfig,
  ModelConfig,
  ChatMessage,
  ChatMessagePart,
  Conversation,
} from '@/types';

/** Max auto-retry attempts for recoverable errors */
const MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff (doubles each attempt) */
const RETRY_BASE_DELAY = 1500;

export default function App() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const {
    conversations,
    current: currentConversation,
    save: saveConversation,
    open: openConversation,
    remove: removeConversation,
    clearAll: clearAllConversations,
  } = useConversations();
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingParts, setStreamingParts] = useState<ChatMessagePart[]>([]);
  const [chatError, setChatError] = useState<ChatErrorInfo | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Identifies the request that currently owns the UI. Switching/creating a
  // conversation clears it, so late callbacks from a discarded stream can no
  // longer write back into the freshly opened chat.
  const activeRequestIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useConversationScroll();

  useEffect(() => {
    loadData();
  }, []);

  // Watch for storage changes from options page (or other contexts)
  useStorageWatchMultiple(
    ['providers', 'selectedModel'],
    useCallback((key, newValue) => {
      if (key === 'providers') {
        const newProviders = (newValue as ProviderConfig[] | undefined) || [];
        setProviders(newProviders);
      } else if (key === 'selectedModel') {
        const model = newValue as { providerId: string; modelId: string } | null | undefined;
        if (model) {
          setSelectedProviderId(model.providerId);
          setSelectedModelId(model.modelId);
        }
      }
    }, []),
  );

  async function loadData() {
    const [provs, selectedModel] = await Promise.all([
      storage.getProviders(),
      storage.getSelectedModel(),
    ]);
    setProviders(provs);
    if (selectedModel) {
      setSelectedProviderId(selectedModel.providerId);
      setSelectedModelId(selectedModel.modelId);
    } else if (provs.length > 0) {
      const firstProvider = provs[0]!;
      if (firstProvider.models.length > 0) {
        setSelectedProviderId(firstProvider.id);
        setSelectedModelId(firstProvider.models[0]!.id);
      }
    }
  }

  function getSelectedProvider(): ProviderConfig | undefined {
    return providers.find((p) => p.id === selectedProviderId);
  }

  function getSelectedModel(): ModelConfig | undefined {
    const provider = getSelectedProvider();
    return provider?.models.find((m) => m.id === selectedModelId);
  }

  function isVisionModel(): boolean {
    return getSelectedModel()?.isVision ?? false;
  }

  const handleModelChange = async (value: string) => {
    // value format: providerId::modelId
    const parts = value.split('::');
    const providerId = parts[0] ?? '';
    const modelId = parts[1] ?? '';
    setSelectedProviderId(providerId);
    setSelectedModelId(modelId);
    await storage.setSelectedModel({ providerId, modelId });
  };

  // Cancels the in-flight request and invalidates its pending callbacks.
  const abortActiveStream = useCallback(() => {
    activeRequestIdRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    setIsStreaming(false);
    setStreamingParts([]);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
  }, []);

  /**
   * Leaves the current conversation: any in-flight stream is abandoned and the
   * composer is reset before `target` (or a blank chat) takes over.
   */
  const switchConversation = useCallback(
    async (target: Conversation | null) => {
      abortActiveStream();
      setInput('');
      setImages([]);
      await openConversation(target);
    },
    [abortActiveStream, openConversation],
  );

  const handleNewChat = () => switchConversation(null);

  const handleSelectConversation = async (conversation: Conversation) => {
    setIsHistoryOpen(false);
    if (conversation.id === currentConversation?.id) return;
    await switchConversation(conversation);
  };

  const handleDeleteConversation = async (id: string) => {
    // Deleting the open conversation leaves its stream with no destination.
    if (await removeConversation(id)) {
      abortActiveStream();
      setInput('');
      setImages([]);
    }
  };

  const handleClearAllConversations = async () => {
    abortActiveStream();
    setInput('');
    setImages([]);
    await clearAllConversations();
  };

  const handleOpenSettings = () => {
    chrome.runtime.openOptionsPage();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!isVisionModel()) return;
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const base64 = ev.target?.result as string;
            setImages((prev) => [...prev, base64]);
          };
          reader.readAsDataURL(file);
        }
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isVisionModel()) return;
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const base64 = ev.target?.result as string;
          setImages((prev) => [...prev, base64]);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if ((!input.trim() && images.length === 0) || isStreaming) return;

    const provider = getSelectedProvider();
    const model = getSelectedModel();
    if (!provider || !model) return;

    const text = input.trim();
    const userParts: ChatMessagePart[] = [
      ...images.map((image) => ({
        type: 'file' as const,
        mediaType: /^data:([^;,]+)[;,]/.exec(image)?.[1] ?? 'image/png',
        url: image,
      })),
      ...(text ? [{ type: 'text' as const, text, state: 'done' as const }] : []),
    ];

    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      parts: userParts,
      timestamp: Date.now(),
    };

    let conv = currentConversation;
    if (!conv) {
      conv = {
        id: uuidv4(),
        title: text.slice(0, 50) || t('sidebar.newChat'),
        messages: [],
        modelId: selectedModelId,
        providerId: selectedProviderId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    conv = {
      ...conv,
      messages: [...conv.messages, userMessage],
      updatedAt: Date.now(),
    };

    setInput('');
    setImages([]);
    setIsStreaming(true);
    setStreamingParts([]);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);

    // Persist the user turn before streaming so closing the side panel (or a
    // service worker restart) cannot lose it. The assistant reply is appended
    // on top of this snapshot once the stream settles.
    const convWithUserMessage = conv;
    await openConversation(convWithUserMessage);
    await saveConversation(convWithUserMessage, { create: true });

    await executeStream(convWithUserMessage, provider, model, 0);
  };

  /**
   * Executes the stream request. Separated from `handleSend` so it can be
   * called again on retries without re-preparing the conversation.
   */
  const executeStream = async (
    convWithUserMessage: Conversation,
    provider: ProviderConfig,
    model: ModelConfig,
    attempt: number,
  ) => {
    // `chatStream` turns these into the model prompt, replaying earlier tool
    // calls and their results so the model can reason over them.
    const uiMessages = toUIMessages(convWithUserMessage.messages);
    // Read at send time so edits in the options page apply to the next turn.
    const system = resolveSystemPrompt(await storage.getSystemPrompt());

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const requestId = uuidv4();
    activeRequestIdRef.current = requestId;

    const isStale = () => activeRequestIdRef.current !== requestId;

    // Per-request snapshot: a shared ref would be cleared by `abortActiveStream`
    // before the aborted stream's final callback runs.
    let latestParts: ChatMessagePart[] = [];

    const persist = async (parts: ChatMessagePart[]) => {
      const stale = isStale();

      if (!stale) {
        activeRequestIdRef.current = null;
        abortControllerRef.current = null;
        setIsStreaming(false);
        setStreamingParts([]);
        setChatError(null);
        setIsRetrying(false);
        setRetryAttempt(0);
      }

      if (!hasRenderableParts(parts)) {
        return;
      }

      const assistantMessage: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        parts,
        timestamp: Date.now(),
      };

      const updatedConv: Conversation = {
        ...convWithUserMessage,
        messages: [...convWithUserMessage.messages, assistantMessage],
        updatedAt: Date.now(),
      };

      // Always commit the reply — even when the user has moved on it belongs to
      // the conversation it was generated for. Skipped if that conversation was
      // deleted in the meantime.
      await saveConversation(updatedConv);

      // Only take over the UI if this request still owns it, otherwise we would
      // resurrect the abandoned conversation over the newly opened one.
      if (stale) return;
      await openConversation(updatedConv);
    };

    await chatStream({
      provider,
      model,
      messages: uiMessages,
      system,
      signal: controller.signal,
      onUpdate: (parts) => {
        latestParts = parts;
        if (isStale()) return;
        setStreamingParts(parts);
      },
      onFinish: persist,
      onError: (error) => {
        if (isStale()) return;

        const errorInfo = classifyError(error);
        const canRetry = isRetryableError(errorInfo.category);
        const nextAttempt = attempt + 1;

        // If auto-retryable and under the limit, schedule a retry
        if (canRetry && nextAttempt <= MAX_RETRIES) {
          setChatError(errorInfo);
          setIsRetrying(true);
          setRetryAttempt(nextAttempt);
          // Keep any streamed parts visible during retry
          if (latestParts.length > 0) {
            setStreamingParts(latestParts);
          }

          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            void executeStream(convWithUserMessage, provider, model, nextAttempt);
          }, delay);
        } else {
          // No more retries: show the error permanently
          setIsStreaming(false);
          setStreamingParts(latestParts);
          setChatError(errorInfo);
          setIsRetrying(false);
          setRetryAttempt(nextAttempt > MAX_RETRIES ? MAX_RETRIES : nextAttempt);
          abortControllerRef.current = null;
          activeRequestIdRef.current = null;
        }
      },
    });
  };

  /** Manual retry triggered by the user clicking the Retry button */
  const handleRetry = () => {
    if (!currentConversation || isStreaming) return;

    const provider = getSelectedProvider();
    const model = getSelectedModel();
    if (!provider || !model) return;

    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
    setIsStreaming(true);
    setStreamingParts([]);

    void executeStream(currentConversation, provider, model, 0);
  };

  const handleStop = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    abortControllerRef.current?.abort();
    setIsStreaming(false);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}::${m.id}`,
      label: `${m.displayName} (${p.name})`,
    }))
  );

  const currentModelValue = selectedProviderId && selectedModelId
    ? `${selectedProviderId}::${selectedModelId}`
    : '';

  // `step-start` parts arrive before any content, so fall back to the thinking
  // indicator until there is something actually renderable.
  const isStreamingVisible = hasRenderableParts(streamingParts);

  return (
    <div className="relative flex flex-col h-screen w-full bg-background overflow-hidden">
      <ThemeInit />
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
      {/* Header */}
      <header className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <Select value={currentModelValue} onValueChange={handleModelChange}>
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
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleNewChat} title={t('sidebar.newChat')}>
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setIsHistoryOpen(true)}
            title={t('sidebar.history.title')}
          >
            <History className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleOpenSettings} title={t('sidebar.settings')}>
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Messages */}
      <ConversationContainer className="flex-1">
        <ConversationContent scrollRef={scrollRef} contentRef={contentRef}>
          {allModels.length === 0 && (
            <div className="text-center text-muted-foreground text-sm py-8">
              {t('sidebar.noModels')}
            </div>
          )}
          {currentConversation?.messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {isStreaming && isStreamingVisible && (
            <Message from="assistant">
              <MessageContent>
                <MessagePartList parts={streamingParts} isStreaming />
              </MessageContent>
            </Message>
          )}
          {isStreaming && !isStreamingVisible && !chatError && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 text-muted-foreground text-sm py-1"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
              {t('sidebar.thinking')}
            </motion.div>
          )}
          {/* Show partial content when retrying (content streamed before error) */}
          {!isStreaming && streamingParts.length > 0 && chatError && (
            <Message from="assistant">
              <MessageContent>
                <MessagePartList parts={streamingParts} />
              </MessageContent>
            </Message>
          )}
          {/* Error display with retry controls */}
          <AnimatePresence>
            {chatError && (
              <ChatError
                error={chatError}
                isRetrying={isRetrying}
                retryAttempt={retryAttempt}
                maxRetries={MAX_RETRIES}
                onRetry={handleRetry}
              />
            )}
          </AnimatePresence>
        </ConversationContent>
        <ConversationScrollButton isAtBottom={isAtBottom} scrollToBottom={scrollToBottom} />
      </ConversationContainer>

      {/* Prompt Input */}
      <div className="p-3 shrink-0">
        <div
          className="rounded-xl border border-border bg-muted/50 overflow-hidden transition-colors focus-within:border-chat-user/50"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {/* Attachment previews inside the input box */}
          <AnimatePresence>
            {images.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="px-3 pt-3 flex gap-2 overflow-x-auto scrollbar-lumo"
              >
                {images.map((img, i) => (
                  <div key={i} className="relative shrink-0 group">
                    <img src={img} className="h-14 w-14 object-cover rounded-lg" alt="" />
                    <button
                      onClick={() => removeImage(i)}
                      className="absolute -top-1.5 -right-1.5 bg-foreground/80 text-background rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Textarea body */}
          <div className="px-3 pt-3 pb-1">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('sidebar.placeholder')}
              className="min-h-[36px] max-h-[120px] resize-none text-sm border-0 bg-transparent p-0 shadow-none placeholder:text-muted-foreground/60"
              rows={1}
            />
          </div>

          {/* Footer toolbar */}
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-0.5">
              {isVisionModel() && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    const inp = document.createElement('input');
                    inp.type = 'file';
                    inp.accept = 'image/*';
                    inp.multiple = true;
                    inp.onchange = (e) => {
                      const files = (e.target as HTMLInputElement).files;
                      if (files) {
                        Array.from(files).forEach((file) => {
                          const reader = new FileReader();
                          reader.onload = (ev) => {
                            setImages((prev) => [...prev, ev.target?.result as string]);
                          };
                          reader.readAsDataURL(file);
                        });
                      }
                    };
                    inp.click();
                  }}
                  title={t('sidebar.pasteImage')}
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center">
              {isStreaming ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-lg text-destructive hover:text-destructive"
                  onClick={handleStop}
                >
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-30"
                  onClick={handleSend}
                  disabled={!input.trim() && images.length === 0}
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

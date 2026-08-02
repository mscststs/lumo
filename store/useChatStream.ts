import { useState, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { chatStream } from '@/lib/ai';
import { storage } from '@/store/storage';
import { useConversations } from '@/store/useConversations';
import { hasRenderableParts, toUIMessages } from '@/lib/message-parts';
import { resolveSystemPrompt } from '@/lib/system-prompt';
import { classifyError, isRetryableError } from '@/components/chat/ChatError';
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import type { ProviderConfig, ModelConfig, ChatMessage, ChatMessagePart, Conversation, TextAttachment } from '@/types';

/** Max auto-retry attempts for recoverable errors */
const MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff (doubles each attempt) */
const RETRY_BASE_DELAY = 1500;

export interface UseChatStreamReturn {
  conversations: Conversation[];
  currentConversation: Conversation | null;
  isHistoryOpen: boolean;
  setIsHistoryOpen: (open: boolean) => void;
  isStreaming: boolean;
  streamingParts: ChatMessagePart[];
  chatError: ChatErrorInfo | null;
  isRetrying: boolean;
  retryAttempt: number;
  isStreamingVisible: boolean;
  handleSend: (input: string, images: string[], textAttachments: TextAttachment[], getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined, selectedProviderId: string, selectedModelId: string) => Promise<void>;
  handleRetry: (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => void;
  handleStop: () => void;
  handleNewChat: () => void;
  handleSelectConversation: (conversation: Conversation) => Promise<void>;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleClearAllConversations: () => Promise<void>;
}

/**
 * Hook that encapsulates all streaming chat logic including:
 * - Sending messages and managing stream lifecycle
 * - Auto-retry with exponential backoff
 * - Aborting in-flight requests
 * - Conversation management (new, switch, delete, clear)
 */
export function useChatStream(): UseChatStreamReturn {
  const {
    conversations,
    current: currentConversation,
    save: saveConversation,
    open: openConversation,
    remove: removeConversation,
    clearAll: clearAllConversations,
  } = useConversations();

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingParts, setStreamingParts] = useState<ChatMessagePart[]>([]);
  const [chatError, setChatError] = useState<ChatErrorInfo | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Identifies the request that currently owns the UI.
  const activeRequestIdRef = useRef<string | null>(null);

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
      await openConversation(target);
    },
    [abortActiveStream, openConversation],
  );

  const handleNewChat = useCallback(() => {
    void switchConversation(null);
  }, [switchConversation]);

  const handleSelectConversation = useCallback(
    async (conversation: Conversation) => {
      setIsHistoryOpen(false);
      if (conversation.id === currentConversation?.id) return;
      await switchConversation(conversation);
    },
    [currentConversation?.id, switchConversation],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      if (await removeConversation(id)) {
        abortActiveStream();
      }
    },
    [removeConversation, abortActiveStream],
  );

  const handleClearAllConversations = useCallback(async () => {
    abortActiveStream();
    await clearAllConversations();
  }, [abortActiveStream, clearAllConversations]);

  /**
   * Executes the stream request. Separated from `handleSend` so it can be
   * called again on retries without re-preparing the conversation.
   */
   const executeStream = useCallback(
    async (
      _conv: Conversation,
      provider: ProviderConfig,
      model: ModelConfig,
      attempt: number,
    ) => {
      // Reuse the system prompt snapshot stored in the conversation so that
      // time-injected prompts stay stable across messages and provider prompt
      // caching can work. Only generate a fresh one for brand-new conversations.
      let system: string | undefined;
      let convWithUserMessage: Conversation;
      if (_conv.systemPrompt !== undefined) {
        system = _conv.systemPrompt;
        convWithUserMessage = _conv;
      } else {
        system = resolveSystemPrompt(await storage.getSystemPrompt());
        // Persist the resolved prompt into the conversation object so
        // subsequent messages in this conversation reuse the same value.
        convWithUserMessage = { ..._conv, systemPrompt: system ?? undefined };
      }

      const uiMessages = toUIMessages(convWithUserMessage.messages);

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const requestId = uuidv4();
      activeRequestIdRef.current = requestId;

      const isStale = () => activeRequestIdRef.current !== requestId;

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

        await saveConversation(updatedConv);

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

          if (canRetry && nextAttempt <= MAX_RETRIES) {
            setChatError(errorInfo);
            setIsRetrying(true);
            setRetryAttempt(nextAttempt);
            if (latestParts.length > 0) {
              setStreamingParts(latestParts);
            }

            const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
            retryTimeoutRef.current = setTimeout(() => {
              retryTimeoutRef.current = null;
              void executeStream(convWithUserMessage, provider, model, nextAttempt);
            }, delay);
          } else {
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
    },
    [saveConversation, openConversation],
  );

  const handleSend = useCallback(
    async (
      input: string,
      images: string[],
      textAttachments: TextAttachment[],
      getProvider: () => ProviderConfig | undefined,
      getModel: () => ModelConfig | undefined,
      selectedProviderId: string,
      selectedModelId: string,
    ) => {
      const text = input.trim();
      if (!text && images.length === 0 && textAttachments.length === 0) return;
      if (isStreaming) return;

      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;

      const userParts: ChatMessagePart[] = [
        ...images.map((image) => ({
          type: 'file' as const,
          mediaType: /^data:([^;,]+)[;,]/.exec(image)?.[1] ?? 'image/png',
          url: image,
        })),
        ...textAttachments.map((attachment) => ({
          type: 'text' as const,
          text: attachment.mediaType === 'text/html'
            ? `[HTML Content]\n${attachment.content}`
            : attachment.content,
          state: 'done' as const,
        })),
        ...(text ? [{ type: 'text' as const, text, state: 'done' as const }] : []),
      ];

      const userMessage: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        parts: userParts,
        textAttachments: textAttachments.length > 0 ? textAttachments : undefined,
        timestamp: Date.now(),
      };

      let conv = currentConversation;
      if (!conv) {
        conv = {
          id: uuidv4(),
          title: text.slice(0, 50) || 'New Chat',
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

      setIsStreaming(true);
      setStreamingParts([]);
      setChatError(null);
      setIsRetrying(false);
      setRetryAttempt(0);

      const convWithUserMessage = conv;
      await openConversation(convWithUserMessage);
      await saveConversation(convWithUserMessage, { create: true });

      await executeStream(convWithUserMessage, provider, model, 0);
    },
    [isStreaming, currentConversation, openConversation, saveConversation, executeStream],
  );

  const handleRetry = useCallback(
    (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => {
      if (!currentConversation || isStreaming) return;

      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;

      setChatError(null);
      setIsRetrying(false);
      setRetryAttempt(0);
      setIsStreaming(true);
      setStreamingParts([]);

      void executeStream(currentConversation, provider, model, 0);
    },
    [currentConversation, isStreaming, executeStream],
  );

  const handleStop = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    abortControllerRef.current?.abort();
    setIsStreaming(false);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
  }, []);

  const isStreamingVisible = hasRenderableParts(streamingParts);

  return {
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
  };
}

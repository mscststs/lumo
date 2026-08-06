import { useState, useRef, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { chatStream, resumeFingerprint } from '@/lib/ai';
import type { ResumeState } from '@/lib/ai';
import { storage } from '@/store/storage';
import { useConversations } from '@/store/useConversations';
import { hasRenderableParts, toUIMessages } from '@/lib/message-parts';
import { resolveSystemPrompt } from '@/lib/system-prompt';
import { classifyError, isRetryableError } from '@/components/chat/ChatError';
import { toError } from '@/lib/provider-error';
import type { ConversationMeta } from '@/lib/conversation-store';
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import type { ProviderConfig, ModelConfig, ChatMessage, ChatMessagePart, Conversation, TextAttachment } from '@/types';

/** Max auto-retry attempts for recoverable errors */
const MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff (doubles each attempt) */
const RETRY_BASE_DELAY = 1500;

/**
 * Identity of one assistant turn, allocated before the first chunk arrives so
 * the streaming bubble and the persisted message agree on both fields.
 */
interface AssistantTurn {
  /** The id the finished message will be saved under. */
  id: string;
  /** When the turn started — kept across retries so it reflects the user's ask. */
  timestamp: number;
}

export interface UseChatStreamReturn {
  /**
   * History list entries. Summaries rather than full conversations — the list
   * never needs message bodies. See `useConversations`.
   */
  conversations: ConversationMeta[];
  currentConversation: Conversation | null;
  isHistoryOpen: boolean;
  setIsHistoryOpen: (open: boolean) => void;
  isStreaming: boolean;
  /**
   * The in-flight assistant turn, shaped as a real `ChatMessage` so the list can
   * render it through the same component and React key as the persisted one.
   * `null` until the turn has produced something worth showing.
   */
  streamingMessage: ChatMessage | null;
  chatError: ChatErrorInfo | null;
  isRetrying: boolean;
  retryAttempt: number;
  handleSend: (input: string, images: string[], textAttachments: TextAttachment[], getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined, selectedProviderId: string, selectedModelId: string) => Promise<void>;
  handleRetry: (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => void;
  handleStop: () => void;
  handleNewChat: () => void;
  handleSelectConversation: (id: string) => Promise<void>;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleClearAllConversations: () => Promise<void>;
}

export interface UseChatStreamOptions {
  /** Panel identifier for independent conversation state. Default 0. */
  panelId?: number;
  /** Session IDs occupied by other panels (for conflict detection on restore) */
  occupiedSessionIds?: string[];
}

/**
 * Hook that encapsulates all streaming chat logic including:
 * - Sending messages and managing stream lifecycle
 * - Auto-retry with exponential backoff
 * - Aborting in-flight requests
 * - Conversation management (new, switch, delete, clear)
 */
export function useChatStream(options?: UseChatStreamOptions): UseChatStreamReturn {
  const {
    conversations,
    current: currentConversation,
    save: saveConversation,
    open: openConversation,
    openById: openConversationById,
    remove: removeConversation,
    clearAll: clearAllConversations,
  } = useConversations({
    panelId: options?.panelId ?? 0,
    occupiedSessionIds: options?.occupiedSessionIds,
  });

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingParts, setStreamingParts] = useState<ChatMessagePart[]>([]);
  // Identity of the assistant message currently being streamed: the id it will
  // be saved under, plus the moment the turn started. Allocated when the turn
  // starts and reused verbatim when it is persisted, so the streaming bubble and
  // the saved bubble are the same React element (same key, same position) and
  // the DOM is patched in place instead of being torn down and rebuilt — which
  // is what made the finished reply visibly flash.
  const [streamingTurn, setStreamingTurn] = useState<AssistantTurn | null>(null);
  // Mirrors `streamingTurn` for callbacks that must read it without re-running.
  // Survives retries so a resumed turn keeps rendering under the same key and
  // reports the time the user actually asked, not the time of the last attempt.
  const streamingTurnRef = useRef<AssistantTurn | null>(null);
  const [chatError, setChatError] = useState<ChatErrorInfo | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Identifies the request that currently owns the UI.
  const activeRequestIdRef = useRef<string | null>(null);
  // Last completed agent-loop step of the current assistant turn. A retry
  // replays this instead of the whole turn, so finished tool calls are not run
  // twice. Held in a ref because it must survive the delay between a failure
  // and the retry without re-rendering.
  const resumeStateRef = useRef<ResumeState | null>(null);

  // Cancels the in-flight request and invalidates its pending callbacks.
  const abortActiveStream = useCallback(() => {
    activeRequestIdRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    resumeStateRef.current = null;
    streamingTurnRef.current = null;
    setIsStreaming(false);
    setStreamingParts([]);
    setStreamingTurn(null);
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
    void switchConversation(null).catch((error) => {
      console.error('[Lumo] Failed to start a new chat:', error);
    });
  }, [switchConversation]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      setIsHistoryOpen(false);
      if (id === currentConversation?.id) return;
      abortActiveStream();
      await openConversationById(id);
    },
    [currentConversation?.id, abortActiveStream, openConversationById],
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
   *
   * `resume` replays the last completed agent-loop step instead of the whole
   * turn, so a mid-turn failure does not re-run tool calls that already
   * succeeded. It is dropped when its fingerprint no longer matches the request
   * about to be sent (different conversation, provider, model, or history
   * length), because the snapshot is a provider-shaped model prompt.
   *
   * `canCreate` lets the final save insert the conversation when the initial
   * write of the user turn failed. Normally the save must *not* insert, so a
   * stream settling after the user deleted its conversation cannot resurrect it.
   */
   const executeStream = useCallback(
    async (
      _conv: Conversation,
      provider: ProviderConfig,
      model: ModelConfig,
      attempt: number,
      resume?: ResumeState | null,
      { canCreate = false }: { canCreate?: boolean } = {},
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

      const fingerprint = resumeFingerprint({
        conversationId: convWithUserMessage.id,
        provider,
        model,
        messageCount: convWithUserMessage.messages.length,
      });
      const resumeFrom =
        resume && resume.fingerprint === fingerprint ? resume : undefined;
      // A mismatched snapshot must not leak into the next attempt either.
      resumeStateRef.current = resumeFrom ?? null;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const requestId = uuidv4();
      activeRequestIdRef.current = requestId;

      const isStale = () => activeRequestIdRef.current !== requestId;

      let latestParts: ChatMessagePart[] = resumeFrom ? [...resumeFrom.parts] : [];

      // Identity for the assistant message this turn produces. Reused for both
      // the live streaming bubble and the persisted one. A retry inherits the
      // existing turn so the saved timestamp is when the user asked.
      const turn: AssistantTurn = streamingTurnRef.current ?? {
        id: uuidv4(),
        timestamp: Date.now(),
      };
      streamingTurnRef.current = turn;
      setStreamingTurn(turn);

      const persist = async (parts: ChatMessagePart[]) => {
        const stale = isStale();
        const renderable = hasRenderableParts(parts);

        const updatedConv: Conversation | null = renderable
          ? {
              ...convWithUserMessage,
              messages: [
                ...convWithUserMessage.messages,
                {
                  // Same id and timestamp the streaming bubble already rendered
                  // under, so the hand-off from "live" to "saved" reuses the
                  // existing DOM instead of unmounting and remounting the reply.
                  ...turn,
                  role: 'assistant',
                  parts,
                } satisfies ChatMessage,
              ],
              updatedAt: Date.now(),
            }
          : null;

        if (!stale) {
          activeRequestIdRef.current = null;
          abortControllerRef.current = null;
          resumeStateRef.current = null;
          streamingTurnRef.current = null;

          // These all land in a single React commit: the finished message is
          // appended to the conversation in the very same render that drops the
          // streaming state. Awaiting in between would paint a frame with the
          // reply missing, which is what made the completed message flash.
          // `openConversation` applies its state update synchronously and only
          // then persists the pointer, so it is safe not to await here.
          if (updatedConv) {
            void openConversation(updatedConv).catch(() => {
              // Pointer persistence is best-effort; the id is unchanged anyway.
            });
          }
          setIsStreaming(false);
          setStreamingParts([]);
          setStreamingTurn(null);
          setChatError(null);
          setIsRetrying(false);
          setRetryAttempt(0);
        }

        if (!updatedConv) return;

        // Surfaced rather than swallowed: this used to reject into
        // `chatStream`'s already-settled `onFinish`, so a failed save left the
        // reply on screen but absent from disk — it vanished on reload with no
        // indication anything had gone wrong.
        try {
          await saveConversation(updatedConv, { create: canCreate });
        } catch (error) {
          if (stale) return;
          setChatError(classifyError(toError(error)));
        }
      };

      await chatStream({
        provider,
        model,
        messages: uiMessages,
        system,
        signal: controller.signal,
        conversationId: convWithUserMessage.id,
        resume: resumeFrom,
        onStepComplete: (checkpoint) => {
          if (isStale()) return;
          resumeStateRef.current = { ...checkpoint, fingerprint };
        },
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

            const resumeForRetry = resumeStateRef.current;
            const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
            retryTimeoutRef.current = setTimeout(() => {
              retryTimeoutRef.current = null;
              void executeStream(
                convWithUserMessage,
                provider,
                model,
                nextAttempt,
                resumeForRetry,
                { canCreate },
              ).catch((retryError) => {
                // Same hazard as the initial send: an unhandled rejection here
                // would leave `isStreaming` stuck true with nothing on screen.
                setIsStreaming(false);
                setStreamingTurn(null);
                setIsRetrying(false);
                setChatError(classifyError(toError(retryError)));
              });
            }, delay);
          } else {
            setIsStreaming(false);
            setStreamingParts(latestParts);
            setChatError(errorInfo);
            setIsRetrying(false);
            setRetryAttempt(nextAttempt > MAX_RETRIES ? MAX_RETRIES : nextAttempt);
            abortControllerRef.current = null;
            activeRequestIdRef.current = null;
            // Snapshot is intentionally kept so the manual retry button can
            // still resume from the last completed step.
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
      // A new turn invalidates any snapshot left by the previous one.
      resumeStateRef.current = null;
      // ...and gets a fresh assistant identity, allocated by `executeStream`.
      streamingTurnRef.current = null;
      setStreamingTurn(null);

      const convWithUserMessage = conv;

      // The pointer write is best-effort and applies its state update
      // synchronously, so the user message renders regardless of whether the
      // write lands.
      void openConversation(convWithUserMessage).catch(() => {
        // Losing the pointer only costs conversation restoration on next open.
      });

      // The user turn is persisted before the request because `persist` saves
      // with `insertIfMissing: false` — it must not resurrect a conversation the
      // user deleted mid-stream, which also means it cannot create this one.
      //
      // Crucially this is no longer allowed to gate the request. It used to be a
      // bare `await`, so a storage failure meant `executeStream` was never
      // reached while `isStreaming` stayed true: the composer sat on "thinking"
      // forever showing no error, and `handleSend`'s own `isStreaming` guard
      // then silently swallowed every further attempt.
      let persistedUserTurn = true;
      try {
        await saveConversation(convWithUserMessage, { create: true });
      } catch (error) {
        persistedUserTurn = false;
        // Reported, but the turn still goes to the model: losing history is far
        // less disruptive than losing the ability to talk to the assistant.
        setChatError(classifyError(toError(error)));
      }

      try {
        await executeStream(convWithUserMessage, provider, model, 0, undefined, {
          canCreate: !persistedUserTurn,
        });
      } catch (error) {
        // `chatStream` reports provider failures through `onError`; reaching here
        // means something outside the stream broke (a failed settings read, a
        // storage fault). Without this the rejection escaped into ChatPanel's
        // `void handleSend(...)` and left the panel hung.
        setIsStreaming(false);
        setStreamingParts([]);
        setStreamingTurn(null);
        setIsRetrying(false);
        setChatError(classifyError(toError(error)));
      }
    },
    [isStreaming, currentConversation, openConversation, saveConversation, executeStream],
  );

  const handleRetry = useCallback(
    (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => {
      if (!currentConversation || isStreaming) return;

      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;

      const resume = resumeStateRef.current;

      setChatError(null);
      setIsRetrying(false);
      setRetryAttempt(0);
      setIsStreaming(true);
      // Resuming keeps the already-streamed steps on screen; `executeStream`
      // re-seeds them and appends the remaining steps. Only a full restart
      // clears the transcript, and only then is a new identity warranted.
      if (!resume) {
        setStreamingParts([]);
        streamingTurnRef.current = null;
        setStreamingTurn(null);
      }

      void executeStream(currentConversation, provider, model, 0, resume).catch((error) => {
        setIsStreaming(false);
        setStreamingTurn(null);
        setIsRetrying(false);
        setChatError(classifyError(toError(error)));
      });
    },
    [currentConversation, isStreaming, executeStream],
  );

  const handleStop = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    abortControllerRef.current?.abort();
    // Stopping is an explicit abandon: the partial turn is persisted by
    // `chatStream`'s abort path, so there is nothing left to resume into.
    resumeStateRef.current = null;
    setIsStreaming(false);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
  }, []);

  /**
   * The in-flight turn as a `ChatMessage`. Memoised on the turn identity + parts
   * so the object identity only changes when the content does, letting the
   * message component's `memo` skip renders driven by unrelated panel state.
   */
  const streamingMessage = useMemo<ChatMessage | null>(() => {
    if (!streamingTurn || !hasRenderableParts(streamingParts)) return null;
    return {
      ...streamingTurn,
      role: 'assistant',
      parts: streamingParts,
    };
  }, [streamingTurn, streamingParts]);

  return {
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
  };
}

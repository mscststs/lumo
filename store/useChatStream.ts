import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { chatStream, resumeFingerprint } from '@/lib/ai';
import type { ResumeState, StopReason } from '@/lib/ai';
import { isOcrAvailable } from '@/lib/image-projection';
import { storage } from '@/store/storage';
import { useConversations } from '@/store/useConversations';
import { hasRenderableParts, toUIMessages } from '@/lib/message-parts';
import { deriveConversationTitle } from '@/lib/conversation-title';
import { serializeAttachmentForModel } from '@/lib/attachment-serialization';
import { MAX_RETRIES, retryDelay } from '@/lib/retry-policy';
import { resolveSystemPrompt } from '@/lib/system-prompt';
import { classifyError, isRetryableError } from '@/components/chat/ChatError';
import { toError } from '@/lib/provider-error';
import type { ConversationMeta } from '@/lib/conversation-store';
import type { ChatErrorInfo } from '@/components/chat/ChatError';
import type { ProviderConfig, ModelConfig, ChatMessage, ChatMessagePart, Conversation, TextAttachment, TokenUsageStats } from '@/types';

/**
 * Minimum gap between mid-stream checkpoints of the in-flight assistant turn.
 *
 * A turn can emit hundreds of chunks per second, so checkpointing on every
 * update would queue an IndexedDB write per token. One second bounds how much of
 * a reply an abrupt teardown can cost while keeping writes far apart enough to
 * stay off the render path.
 */
const CHECKPOINT_INTERVAL = 1000;

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
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleRegenerateMessage: (messageId: string, getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => void;
  handleSwitchVariant: (variantIndex: number) => Promise<void>;
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
    saveDraft: saveConversationDraft,
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
  /**
   * How to write the in-flight turn to disk right now.
   *
   * Set for the duration of a stream and cleared when it settles. This is what
   * makes an interrupted reply recoverable: `onFinish` is the only place a turn
   * was ever persisted, and it never runs when the panel is torn down
   * mid-stream, so the reply was lost outright. Teardown handlers and the
   * throttled checkpoint both go through this.
   *
   * A ref rather than state because the teardown effect must read the *current*
   * writer without re-subscribing on every chunk.
   */
  const checkpointRef = useRef<((parts: ChatMessagePart[]) => Promise<void>) | null>(null);
  /** Parts as of the latest update, for teardown to flush without React state. */
  const livePartsRef = useRef<ChatMessagePart[]>([]);
  /** When the last checkpoint was written, to throttle the next one. */
  const lastCheckpointAtRef = useRef(0);
  /** Guards against overlapping checkpoint writes to the same record. */
  const checkpointInFlightRef = useRef(false);
  /**
   * Variants from a regeneration in progress. Attached to the new assistant
   * message when it is persisted, then cleared. Held in a ref so it survives
   * across the async gap between starting the stream and finishing it.
   */
  const regenerateVariantsRef = useRef<import('@/types').ChatMessageVariant[] | null>(null);

  /**
   * Persists the in-flight turn as an interrupted message, if there is one worth
   * keeping. Safe to call when no stream is running.
   *
   * Used by every path that abandons a stream without letting it settle, so a
   * partial reply survives instead of vanishing.
   */
  const flushInterruptedTurn = useCallback(() => {
    const checkpoint = checkpointRef.current;
    const parts = livePartsRef.current;
    if (!checkpoint || !hasRenderableParts(parts)) return;
    // Fire-and-forget: callers include synchronous teardown paths that cannot
    // await. The write itself is a single IndexedDB transaction already in
    // flight by the time this returns.
    void checkpoint(parts).catch((error) => {
      console.error('[Lumo] Failed to persist the interrupted reply:', error);
    });
  }, []);

  // Cancels the in-flight request and invalidates its pending callbacks.
  const abortActiveStream = useCallback(() => {
    // Before the request id is cleared, so the partial reply is still attributed
    // to the turn that produced it.
    flushInterruptedTurn();
    activeRequestIdRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    resumeStateRef.current = null;
    streamingTurnRef.current = null;
    checkpointRef.current = null;
    livePartsRef.current = [];
    setIsStreaming(false);
    setStreamingParts([]);
    setStreamingTurn(null);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
  }, [flushInterruptedTurn]);

  /**
   * Last-chance persistence when the panel goes away mid-stream.
   *
   * This is the case that silently destroyed replies: the assistant turn was
   * only ever written from `chatStream`'s `onFinish`, and closing the side panel
   * (or hiding/removing a split panel) tears the document down before that runs.
   * The user message had already been saved, so reopening showed a question with
   * no answer and no indication anything had been lost.
   *
   * Two triggers, because neither alone is enough:
   * - `visibilitychange` fires while the document is still alive, which is the
   *   only point at which an async IndexedDB write can still be relied on to
   *   commit. Closing the side panel hides it first, so this is the trigger that
   *   actually saves the reply.
   * - unmount covers teardown that never hides the document: a split panel being
   *   closed or collapsed by a width change.
   *
   * `pagehide`/`beforeunload` are deliberately not used: by then only synchronous
   * work is guaranteed to run, and IndexedDB is asynchronous, so a write started
   * there is not guaranteed to land.
   */
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushInterruptedTurn();
    };
    document.addEventListener('visibilitychange', onHidden);

    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      flushInterruptedTurn();
      // Stop the request and any pending retry: nothing is left to render into,
      // and a retry firing after unmount would spend a model call for nobody.
      abortControllerRef.current?.abort();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [flushInterruptedTurn]);

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

      // Read per turn rather than once per hook, so a cap the user changes in the
      // options page applies to the next message instead of the next reload.
      const { maxSteps } = await storage.getUISettings();

      // OCR availability decides whether image-producing tools are exposed, so
      // it belongs in the resume fingerprint alongside vision capability.
      const ocrAvailable = await isOcrAvailable();

      const fingerprint = resumeFingerprint({
        conversationId: convWithUserMessage.id,
        provider,
        model,
        messageCount: convWithUserMessage.messages.length,
        ocrAvailable,
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

      /**
       * The conversation with this turn's assistant message appended, or `null`
       * when the turn has produced nothing worth storing.
       *
       * `interrupted` marks a reply that stopped short of its natural end, so the
       * UI can distinguish a truncated answer from a complete one. `stopReason`
       * narrows that to a cause the user configured rather than one they took, so
       * a reply cut by the step cap can say which cap cut it.
       */
      const withAssistantTurn = (
        parts: ChatMessagePart[],
        { interrupted, stopReason, usage }: { interrupted: boolean; stopReason?: 'step-limit'; usage?: TokenUsageStats },
      ): Conversation | null => {
        if (!hasRenderableParts(parts)) return null;
        const variants = regenerateVariantsRef.current ?? undefined;
        return {
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
              ...(interrupted ? { interrupted: true } : {}),
              ...(stopReason ? { stopReason } : {}),
              ...(usage ? { usage } : {}),
              ...(variants ? { variants } : {}),
            } satisfies ChatMessage,
          ],
          updatedAt: Date.now(),
        };
      };

      /**
       * Writes the turn as it currently stands, flagged as interrupted.
       *
       * Registered for the whole stream so teardown paths can reach it. Uses the
       * draft writer, which skips the list refresh and the cross-panel broadcast:
       * a checkpoint is about durability, not about telling anyone.
       */
      const writeCheckpoint = async (parts: ChatMessagePart[]) => {
        const snapshot = withAssistantTurn(parts, { interrupted: true });
        if (!snapshot) return;
        lastCheckpointAtRef.current = Date.now();
        await saveConversationDraft(snapshot);
      };
      checkpointRef.current = writeCheckpoint;
      livePartsRef.current = latestParts;
      // Seeded so the first chunk of a fresh turn is not checkpointed instantly.
      lastCheckpointAtRef.current = Date.now();

      const persist = async (parts: ChatMessagePart[], stoppedReason: StopReason, usage?: TokenUsageStats) => {
        const stale = isStale();
        // Running out of steps leaves tool calls pending, so it is every bit as
        // truncated as an abort — it just arrives through the success path. Left
        // unflagged, the reply was saved and rendered as if the model had
        // answered, and the only way to get the rest was to type "continue".
        const hitStepLimit = stoppedReason === 'step-limit';
        const updatedConv = withAssistantTurn(parts, {
          // A settled turn is complete unless the user or a teardown cut it
          // short — which is exactly when the signal was aborted — or the step
          // cap did.
          interrupted: controller.signal.aborted || hitStepLimit,
          ...(hitStepLimit ? { stopReason: 'step-limit' as const } : {}),
          usage,
        });

        if (!stale) {
          activeRequestIdRef.current = null;
          abortControllerRef.current = null;
          // Kept when the cap cut the turn short, because work genuinely remains:
          // the last completed step already emitted a checkpoint, and that is what
          // a resume would pick up instead of replaying the whole conversation.
          // Nothing reaches `handleRetry` without an error on screen today, so
          // this is inert until a "continue" affordance exists — but the snapshot
          // has to survive `persist` for one to be possible at all, and a stale
          // one cannot be misused: `resumeFingerprint` includes the message count,
          // which this very save increments.
          if (!hitStepLimit) resumeStateRef.current = null;
          streamingTurnRef.current = null;
          checkpointRef.current = null;
          livePartsRef.current = [];

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
          regenerateVariantsRef.current = null;
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
        isVision: model.isVision,
        maxSteps,
        resume: resumeFrom,
        onStepComplete: (checkpoint) => {
          if (isStale()) return;
          resumeStateRef.current = { ...checkpoint, fingerprint };
          // A completed step is the most valuable thing to have on disk: it may
          // represent a tool call that took seconds and had side effects. Written
          // unconditionally, bypassing the throttle.
          void writeCheckpoint(checkpoint.parts).catch((error) => {
            console.error('[Lumo] Failed to checkpoint the reply:', error);
          });
        },
        onUpdate: (parts) => {
          latestParts = parts;
          livePartsRef.current = parts;
          if (isStale()) return;
          setStreamingParts(parts);

          // Throttled snapshot, so an abrupt teardown loses at most a second of
          // the reply rather than all of it. `checkpointInFlightRef` keeps writes
          // serialised: overlapping transactions on the same record would race,
          // and a slow write must not queue a backlog behind it.
          const now = Date.now();
          if (
            checkpointInFlightRef.current ||
            now - lastCheckpointAtRef.current < CHECKPOINT_INTERVAL
          ) {
            return;
          }
          checkpointInFlightRef.current = true;
          void writeCheckpoint(parts)
            .catch((error) => {
              console.error('[Lumo] Failed to checkpoint the reply:', error);
            })
            .finally(() => {
              checkpointInFlightRef.current = false;
            });
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
            const delay = retryDelay(attempt);
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

            // Persist whatever the failed turn produced. `onError` and `onFinish`
            // are mutually exclusive, so without this a reply that streamed for a
            // while and then hit a non-retryable error stayed on screen but was
            // never written — and vanished on reload. Kept flagged as interrupted
            // because the model never finished; the manual retry can still resume
            // it, which overwrites this snapshot under the same message id.
            void writeCheckpoint(latestParts).catch((persistError) => {
              console.error('[Lumo] Failed to persist the failed reply:', persistError);
            });
          }
        },
      });
    },
    [saveConversation, saveConversationDraft, openConversation],
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
          text: serializeAttachmentForModel(attachment),
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
          title: deriveConversationTitle(text),
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
      // The previous turn's checkpoint writer must not be reachable once a new
      // turn starts, or a teardown could write the old reply onto the new turn.
      checkpointRef.current = null;
      livePartsRef.current = [];

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

    const controller = abortControllerRef.current;
    if (controller) {
      // A live request settles through `chatStream`'s abort path, which routes the
      // partial turn into `onFinish` → `persist`. Flushing here as well would
      // race two writes of the same message against each other.
      controller.abort();
    } else {
      // No request in flight: the user stopped while a retry was waiting out its
      // backoff, so nothing will settle and nothing would otherwise be saved.
      flushInterruptedTurn();
      checkpointRef.current = null;
      livePartsRef.current = [];
    }

    // Stopping is an explicit abandon: the partial turn is persisted by
    // `chatStream`'s abort path, so there is nothing left to resume into.
    resumeStateRef.current = null;
    setIsStreaming(false);
    setChatError(null);
    setIsRetrying(false);
    setRetryAttempt(0);
  }, [flushInterruptedTurn]);

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

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!currentConversation || isStreaming) return;
      const idx = currentConversation.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      // Remove this message and everything after it.
      const updatedMessages = currentConversation.messages.slice(0, idx);
      // If all messages are deleted, remove the conversation entirely.
      if (updatedMessages.length === 0) {
        await removeConversation(currentConversation.id);
        return;
      }
      const updated: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };
      await saveConversation(updated);
      await openConversation(updated);
    },
    [currentConversation, isStreaming, saveConversation, openConversation, removeConversation],
  );

  /**
   * Regenerate from a specific assistant message: removes that message (and
   * everything after it), keeps the preceding user message, and re-sends the
   * request to the model. This is the "Regenerate" affordance — the user is
   * unhappy with this particular response and wants the model to try again.
   */
  const handleRegenerateMessage = useCallback(
    (messageId: string, getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => {
      if (!currentConversation || isStreaming) return;
      const idx = currentConversation.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;

      const message = currentConversation.messages[idx]!;
      // Only the last assistant message can be regenerated.
      if (message.role !== 'assistant') return;
      if (idx !== currentConversation.messages.length - 1) return;

      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;

      // Archive the current response as a variant.
      const existingVariants: import('@/types').ChatMessageVariant[] = message.variants ?? [];
      const currentVariant: import('@/types').ChatMessageVariant = {
        id: message.id,
        parts: message.parts ?? [],
        timestamp: message.timestamp,
        ...(message.interrupted ? { interrupted: true } : {}),
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      };
      // If we are currently viewing an archived variant, archive the shown
      // content back into its slot rather than duplicating it.
      const archivedVariants =
        message.activeVariantIndex !== undefined &&
        message.activeVariantIndex < existingVariants.length
          ? existingVariants // Already archived; just append current parts as new
          : existingVariants;
      const allVariants = [...archivedVariants, currentVariant];

      // Remove the assistant message, keep everything before it.
      const updatedMessages = currentConversation.messages.slice(0, idx);
      if (updatedMessages.length === 0) return;

      const conv: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      // Reset streaming state and fire the request.
      setIsStreaming(true);
      setStreamingParts([]);
      setChatError(null);
      setIsRetrying(false);
      setRetryAttempt(0);
      resumeStateRef.current = null;
      streamingTurnRef.current = null;
      setStreamingTurn(null);
      checkpointRef.current = null;
      livePartsRef.current = [];

      // Stash the variants so the persist callback can attach them.
      regenerateVariantsRef.current = allVariants;

      // Show the trimmed conversation immediately.
      void openConversation(conv).catch(() => {});

      // Persist the trimmed conversation, then execute the stream.
      void saveConversation(conv).then(() => {
        return executeStream(conv, provider, model, 0);
      }).catch((error) => {
        setIsStreaming(false);
        setStreamingParts([]);
        setStreamingTurn(null);
        setIsRetrying(false);
        setChatError(classifyError(toError(error)));
        regenerateVariantsRef.current = null;
      });
    },
    [currentConversation, isStreaming, saveConversation, openConversation, executeStream],
  );

  /**
   * Switch the displayed variant on the last assistant message.
   *
   * `variantIndex` is the index into the combined slots [variants..., current],
   * where the last slot (index === variants.length) represents the latest
   * generation (the message's own `parts`). Only changes `activeVariantIndex`;
   * the actual parts/variants arrays are never mutated here.
   */
  const handleSwitchVariant = useCallback(
    async (variantIndex: number) => {
      if (!currentConversation || isStreaming) return;
      const messages = currentConversation.messages;
      if (messages.length === 0) return;

      const lastIdx = messages.length - 1;
      const lastMsg = messages[lastIdx]!;
      if (lastMsg.role !== 'assistant') return;

      const variants = lastMsg.variants ?? [];
      const totalSlots = variants.length + 1;
      if (variantIndex < 0 || variantIndex >= totalSlots) return;

      // If already showing this slot, no-op.
      const currentActive = lastMsg.activeVariantIndex ?? variants.length;
      if (variantIndex === currentActive) return;

      const isLatestSlot = variantIndex === variants.length;
      const updatedMsg: ChatMessage = {
        ...lastMsg,
        activeVariantIndex: isLatestSlot ? undefined : variantIndex,
      };

      const updatedMessages = [...messages.slice(0, lastIdx), updatedMsg];
      const updated: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      await saveConversation(updated);
      await openConversation(updated);
    },
    [currentConversation, isStreaming, saveConversation, openConversation],
  );

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
    handleDeleteMessage,
    handleRegenerateMessage,
    handleSwitchVariant,
    handleClearAllConversations,
  };
}

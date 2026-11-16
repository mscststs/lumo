import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import {
  Conversation as ConversationContainer,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { CompactionDivider } from '@/components/chat/CompactionDivider';
import { ChatError } from '@/components/chat/ChatError';
import {
  useAnchorChatScroll,
  useAutoChatScroll,
  type ChatScrollApi,
} from '@/components/chat/useChatScroll';
import { useChatScrollMode } from '@/components/chat/useChatScrollMode';
import { MAX_RETRIES } from '@/lib/retry-policy';
import { useMessageDisplaySettings } from '@/components/chat/useMessageDisplaySettings';
import type { ChatErrorInfo } from '@/lib/provider-error';
import type { StepMetrics } from '@/lib/step-metrics';
import type { ChatMessage, Conversation } from '@/types';

interface ChatMessageListProps {
  currentConversation: Conversation | null;
  isStreaming: boolean;
  /** True while old history is being folded into a checkpoint. */
  isCompacting?: boolean;
  /** The in-flight assistant turn, or `null` when it has nothing to show yet. */
  streamingMessage: ChatMessage | null;
  /** Live TTFT/TPS of the in-flight generation, if one is being measured. */
  liveMetrics?: StepMetrics | null;
  chatError: ChatErrorInfo | null;
  isRetrying: boolean;
  retryAttempt: number;
  hasModels: boolean;
  onRetry: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onRegenerateMessage?: (messageId: string) => void;
  onSwitchVariant?: (variantIndex: number) => void;
}

/**
 * The two scroll modes are two different *components*, not a flag inside one.
 *
 * Their scroll controllers own different hooks (`use-stick-to-bottom` vs. the
 * anchored controller), and calling both from one component would mount both
 * controllers at once — the bottom-follower would fight the anchor. Splitting
 * them keeps each mode's hook order intact; switching the mode in
 * Personalization therefore remounts the transcript, which is the right thing
 * to do anyway (the scroll position of one mode is meaningless in the other).
 */
export function ChatMessageList(props: ChatMessageListProps) {
  const mode = useChatScrollMode();
  return mode === 'anchor' ? <AnchorChatMessageList {...props} /> : <AutoChatMessageList {...props} />;
}

function AutoChatMessageList(props: ChatMessageListProps) {
  const scroll = useAutoChatScroll();
  return <ChatMessageListBody {...props} scroll={scroll} />;
}

function AnchorChatMessageList(props: ChatMessageListProps) {
  const scroll = useAnchorChatScroll();
  return <ChatMessageListBody {...props} scroll={scroll} />;
}

interface ChatMessageListBodyProps extends ChatMessageListProps {
  scroll: ChatScrollApi;
}

function ChatMessageListBody({
  currentConversation,
  isStreaming,
  isCompacting = false,
  streamingMessage,
  liveMetrics = null,
  chatError,
  isRetrying,
  retryAttempt,
  hasModels,
  onRetry,
  onDeleteMessage,
  onRegenerateMessage,
  onSwitchVariant,
  scroll,
}: ChatMessageListBodyProps) {
  const { t } = useTranslation();
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = scroll;

  const { toolbar, autoCollapseReasoning, showTtft, showThroughput } =
    useMessageDisplaySettings();

  const persisted = currentConversation?.messages ?? [];
  const compaction = currentConversation?.compaction;
  // The seam is a chronological event, not the prompt-projection boundary: it
  // is drawn *after* the message that was newest when compaction ran, matching
  // pi which appends the compaction message at its chronological position. The
  // retained messages (and the summarized ones, kept for reading) stay above it.
  // Falls back to the projection boundary for records written before the anchor
  // existed.
  const compactionAnchorId =
    compaction?.triggeredAtMessageId ?? compaction?.firstKeptMessageId;

  // ─── Follow the newest content when the user sends ──────────────────────
  // When the reader is scrolled up reviewing history and then sends a message,
  // `use-stick-to-bottom` correctly does NOT auto-follow (it respects the
  // scroll position). But the expectation after sending is to see the new
  // message and the incoming reply, so both modes react here:
  //   auto   → scroll to the bottom
  //   anchor → hold the question at the top of the viewport
  const prevMessageCountRef = useRef(persisted.length);

  useLayoutEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = persisted.length;

    // A new user message was appended
    if (persisted.length > prevCount) {
      const lastMsg = persisted[persisted.length - 1];
      if (lastMsg?.role === 'user') {
        scroll.onUserMessageSent(lastMsg.id);
      }
    }
  }, [persisted.length, scroll]);

  const prevIsStreamingRef = useRef(isStreaming);

  useLayoutEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    // Streaming just started — the reply begins, not every render of it.
    if (isStreaming && !wasStreaming) {
      scroll.onStreamStart();
    }
  }, [isStreaming, scroll]);

  // The streamed turn is persisted under the id it streamed under, so once the
  // conversation contains it the live copy must step aside — otherwise the reply
  // would briefly appear twice.
  const pending =
    streamingMessage && !persisted.some((msg) => msg.id === streamingMessage.id)
      ? streamingMessage
      : null;

  // Persisted and in-flight messages must live in ONE array, not in an array
  // plus a trailing conditional slot. React scopes keys to a position among
  // siblings: a keyed element sitting in its own JSX slot is a different
  // position from the same key inside the mapped array, so when the finished
  // turn moved from the slot into the array React unmounted and remounted it —
  // discarding the DOM and replaying MessageBubble's entry animation. Keeping
  // both in one list makes the hand-off a plain in-place update.
  const rendered = pending ? [...persisted, pending] : persisted;

  // ─── Hold the question that is on screen ────────────────────────────────
  // The newest question is the transcript's reading anchor. Deriving it from
  // the rendered list (rather than from "a send happened") is what makes
  // opening a saved conversation in `anchor` mode start at that question
  // instead of at the bottom.
  //
  // Only two things hand the anchor over: a new question (reported by the send
  // effect above) and a transcript being shown for the first time / after a
  // conversation switch. Edits to older history — a delete, a variant swap —
  // must not yank the reader somewhere else.
  const anchorMessageId = useMemo(() => {
    for (let i = rendered.length - 1; i >= 0; i -= 1) {
      const candidate = rendered[i];
      if (candidate?.role === 'user') return candidate.id;
    }
    return null;
  }, [rendered]);

  const shownConversationId = currentConversation?.id ?? '';
  const shownConversationRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (shownConversationRef.current === shownConversationId) return;
    shownConversationRef.current = shownConversationId;
    // `null` when the conversation has no question yet: the anchored mode uses
    // it to release the room a previous question reserved.
    scroll.onTranscriptShown(anchorMessageId);
  }, [shownConversationId, anchorMessageId, scroll]);

  return (
    <ConversationContainer className="flex-1">
      <ConversationContent
        scrollRef={scrollRef}
        contentRef={contentRef}
        // The anchored controller owns the offset; a silent browser correction
        // would look exactly like a reader's gesture to it.
        className={scroll.disableScrollAnchoring ? '[overflow-anchor:none]' : undefined}
        // Reserved room so a question can be pinned to the top of the viewport
        // before its reply has grown tall enough to allow it. Only the anchored
        // mode asks for it; it must stay outside the measured content element.
        spacerRef={scroll.spacerRef ?? undefined}
      >
        {!hasModels && (
          <div className="text-center text-muted-foreground text-sm py-8">
            {t('sidebar.noModels')}
          </div>
        )}
        {rendered.map((msg, idx) => (
          <Fragment key={msg.id}>
            {/* A layout-only wrapper: `MessageBubble` animates itself in with a
                transform, and a transformed box reports a rect that moves. The
                anchor has to be measured on a box the animation cannot shift. */}
            <div data-message-id={msg.id}>
              <MessageBubble
                message={msg}
                isStreaming={isStreaming && msg.id === pending?.id}
                onDelete={onDeleteMessage}
                onRegenerate={onRegenerateMessage}
                onSwitchVariant={onSwitchVariant}
                isLastAssistant={msg.role === 'assistant' && idx === rendered.length - 1}
                deleteCount={rendered.length - idx}
                toolbar={toolbar}
                autoCollapseReasoning={autoCollapseReasoning}
                showTtft={showTtft}
                showThroughput={showThroughput}
                liveMetrics={isStreaming && msg.id === pending?.id ? liveMetrics : null}
              />
            </div>
            {compaction && compactionAnchorId === msg.id && (
              <CompactionDivider compaction={compaction} />
            )}
          </Fragment>
        ))}
        {(isStreaming || isCompacting) && !pending && !chatError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 text-muted-foreground text-sm py-1"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
            {isCompacting ? t('sidebar.compacting') : t('sidebar.thinking')}
          </motion.div>
        )}
        {/* Error display with retry controls */}
        <AnimatePresence>
          {chatError && (
            <ChatError
              error={chatError}
              isRetrying={isRetrying}
              retryAttempt={retryAttempt}
              maxRetries={MAX_RETRIES}
              onRetry={onRetry}
            />
          )}
        </AnimatePresence>
      </ConversationContent>
      <ConversationScrollButton isAtBottom={isAtBottom} scrollToBottom={scrollToBottom} />
    </ConversationContainer>
  );
}

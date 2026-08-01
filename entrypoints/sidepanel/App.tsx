import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'motion/react';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatInput } from '@/components/chat/ChatInput';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { ThemeInit } from '@/lib/theme';
import { useModelSelection } from '@/store/useModelSelection';
import { useChatStream } from '@/store/useChatStream';

export default function App() {
  const { t } = useTranslation();
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

  const handleOpenSettings = () => {
    chrome.runtime.openOptionsPage();
  };

  const onSend = (input: string, images: string[]) => {
    void handleSend(input, images, getSelectedProvider, getSelectedModel, selectedProviderId, selectedModelId);
  };

  const onRetry = () => {
    handleRetry(getSelectedProvider, getSelectedModel);
  };

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

      <ChatHeader
        currentModelValue={currentModelValue}
        allModels={allModels}
        onModelChange={handleModelChange}
        onNewChat={handleNewChat}
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
        isStreaming={isStreaming}
        isVisionModel={isVisionModel()}
        onSend={onSend}
        onStop={handleStop}
      />
    </div>
  );
}

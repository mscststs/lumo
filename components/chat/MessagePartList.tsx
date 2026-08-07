import { isToolUIPart } from 'ai';
import { MessageResponse } from '@/components/ai-elements/message';
import { Tool } from '@/components/ai-elements/tool';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { partKey, toolPartName, type ToolPart } from '@/lib/message-parts';
import type { ChatMessagePart } from '@/types';

interface MessagePartListProps {
  parts: ChatMessagePart[];
  /** True while this message is still being streamed. */
  isStreaming?: boolean;
}

/**
 * Renders message parts in their original order, so text output and tool
 * invocations appear interleaved exactly as the model produced them.
 */
export function MessagePartList({ parts, isStreaming = false }: MessagePartListProps) {
  return (
    <>
      {parts.map((part, index) => {
        const key = partKey(part, index);

        if (isToolUIPart(part)) {
          const toolPart = part as ToolPart;
          return (
            <Tool
              key={key}
              part={toolPart}
              name={toolPartName(toolPart)}
              // Not `part.state === 'streaming'` like the text parts below: a
              // tool part has no such state, and its own state cannot tell a
              // call that is still running from one the turn abandoned. Only the
              // turn being live distinguishes the two.
              isStreaming={isStreaming}
            />
          );
        }

        switch (part.type) {
          case 'text':
            if (!part.text) return null;
            return (
              <MessageResponse key={key} isStreaming={isStreaming && part.state === 'streaming'}>
                {part.text}
              </MessageResponse>
            );

          case 'reasoning':
            if (!part.text) return null;
            return (
              <Reasoning
                key={key}
                text={part.text}
                isStreaming={isStreaming && part.state === 'streaming'}
              />
            );

          case 'file':
            if (!part.mediaType.startsWith('image')) return null;
            return (
              <img
                key={key}
                src={part.url}
                alt={part.filename ?? ''}
                className="h-20 w-20 rounded object-cover"
              />
            );

          // `step-start`, sources and data parts carry no sidebar-visible content.
          default:
            return null;
        }
      })}
    </>
  );
}

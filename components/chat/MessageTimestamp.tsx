import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import {
  MessageToolbarTooltipContent,
  messageToolbarTriggerClass,
} from '@/components/ai-elements/message';
import { cn } from '@/lib/utils';
import { formatMessageTime, formatMessageTimeTitle } from '@/lib/message-time';
import { useNow } from '@/lib/use-now';

interface MessageTimestampProps {
  /** Epoch milliseconds — the active variant's start time for a reply. */
  timestamp: number;
}

/**
 * The relative timestamp that closes the message toolbar.
 *
 * Styled with `messageToolbarTriggerClass`, the same chrome as the copy, delete
 * and regenerate buttons — same height, radius and hover wash — so the row
 * reads as one strip instead of "three buttons and a caption". It is still a
 * `<time>`, not a `MessageAction`: it has nothing to click, and a button that
 * does nothing is worse than a label that looks like one.
 *
 * The exact date and time live in a `MessageToolbarTooltipContent` — the same
 * portalled tooltip the buttons use — rather than in a native `title`, which
 * used to appear *in addition to* a Radix tooltip the moment the label gained
 * a hover state. `aria-label` carries the full date to assistive tech (the
 * visible text stays relative), and `dateTime` keeps the machine-readable value.
 *
 * `whitespace-nowrap` keeps the label on one line in a narrow side panel;
 * `tabular-nums` stops the row from shifting as the minutes tick; `select-none`
 * keeps a drag across the message from picking up the label; the padding is
 * static, so the hover background never nudges the row by a pixel.
 *
 * A missing or non-positive timestamp renders nothing rather than an
 * `Invalid Date`: `toISOString()` throws on one, and a single malformed record
 * (a hand-edited import, a truncated write) must not take the transcript down.
 */
export function MessageTimestamp({ timestamp }: MessageTimestampProps) {
  const { i18n } = useTranslation();
  const now = useNow();
  const locale = i18n.language;

  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const exact = formatMessageTimeTitle(timestamp, locale);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={new Date(timestamp).toISOString()}
          aria-label={exact}
          className={cn(
            messageToolbarTriggerClass,
            'inline-flex items-center px-1.5 text-xs whitespace-nowrap tabular-nums select-none',
          )}
        >
          {formatMessageTime(timestamp, now, locale)}
        </time>
      </TooltipTrigger>
      <MessageToolbarTooltipContent>{exact}</MessageToolbarTooltipContent>
    </Tooltip>
  );
}

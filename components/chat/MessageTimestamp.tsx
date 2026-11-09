import { useTranslation } from 'react-i18next';
import { formatMessageTime, formatMessageTimeTitle } from '@/lib/message-time';
import { useNow } from '@/lib/use-now';

interface MessageTimestampProps {
  /** Epoch milliseconds — the active variant's start time for a reply. */
  timestamp: number;
}

/**
 * The relative timestamp that closes the message toolbar.
 *
 * A `<time>` element with the raw ISO value in `dateTime` (so assistive tech and
 * extraction tools see a machine-readable date) and the full localised date and
 * time in `title` (native tooltip — the toolbar already carries Radix tooltips
 * on its buttons, and a second popper surface would need its own collision
 * handling for a label the browser can show for free).
 *
 * Plain text, not a `MessageAction`: it has nothing to click, and a 24px hit
 * area around two words would read as a button. `whitespace-nowrap` keeps the
 * label on one line in a narrow side panel; `tabular-nums` stops the row from
 * shifting as the minutes tick; `select-none` keeps a drag across the message
 * from picking up the label.
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

  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      title={formatMessageTimeTitle(timestamp, locale)}
      className="px-1 text-xs whitespace-nowrap tabular-nums text-muted-foreground select-none"
    >
      {formatMessageTime(timestamp, now, locale)}
    </time>
  );
}

import { useTranslation } from 'react-i18next';
import { Hint } from '@/components/ui/hint';
import { messageToolbarTriggerClass } from '@/components/ai-elements/message';
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
 * reads as one strip instead of "three buttons and a caption".
 *
 * The exact date and time live in a `Hint` rather than in a native `title`,
 * which used to appear *in addition to* a Radix tooltip the moment the label
 * gained a hover state.
 *
 * ## Why the trigger changes shape with the pointer
 *
 * On a fine pointer the element stays a `<time>`: hovering or focusing it
 * reveals the exact date, and there is nothing to click, because a button that
 * does nothing is worse than a label that looks like one.
 *
 * On a touchscreen there is no hover, so the same information has to be
 * reachable by tapping — and a tap target must be a real button (`aria-expanded`
 * and light dismiss come with it). A `<time>` with a click handler bolted on
 * would announce itself as text and never reach a screen reader's control list.
 * The visible text stays relative in both modes; `dateTime` keeps the
 * machine-readable value, and the exact date is carried in the accessible name
 * instead of an `aria-label` that would contradict the visible label
 * (WCAG 2.5.3).
 *
 * `provider: 'inherit'` keeps this label in the toolbar row's provider, so
 * sliding from copy to time does not restart the 300ms delay.
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

  const label = formatMessageTime(timestamp, now, locale);
  const exact = formatMessageTimeTitle(timestamp, locale);
  const iso = new Date(timestamp).toISOString();
  const chrome = cn(
    messageToolbarTriggerClass,
    'inline-flex items-center px-1.5 text-xs whitespace-nowrap tabular-nums select-none',
  );

  return (
    <Hint
      provider="inherit"
      contentLabel={label}
      trigger={(mode) =>
        mode === 'tap' ? (
          <button type="button" className={chrome}>
            <time dateTime={iso}>{label}</time>
            {/* The exact date is the panel's payload; carrying it in the name
                too means a screen reader gets it without opening anything. */}
            <span className="sr-only">{exact}</span>
          </button>
        ) : (
          <time dateTime={iso} aria-label={exact} className={chrome}>
            {label}
          </time>
        )
      }
    >
      {exact}
    </Hint>
  );
}

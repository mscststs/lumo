import { CornerDownLeft } from 'lucide-react';
import { cn, isMacPlatform } from '@/lib/utils';
import type { SendKey } from '@/types';

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-muted px-1 font-mono text-[0.6875rem] leading-none text-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * The key combination a `SendKey` value stands for.
 *
 * `'meta-enter'` means "a modifier plus Enter" (`types/index.ts`), not a
 * specific key. It used to print every modifier the app accepts — ⌘/⌥/⇧ on
 * macOS, Ctrl/Alt/⇧ elsewhere — separated by slashes. That cluster was the
 * widest thing on the personalisation page: it stretched its own `select` past
 * every neighbouring control and repeated what the setting row's description
 * already spells out. One representative modifier says the same thing in the
 * space of a keycap, so the badge is `⌘ + ⏎` or `Ctrl + ⏎`.
 *
 * The keycap names are literal (⌘, Ctrl, ⇧, Enter): they label physical keys,
 * which are printed this way on every keyboard regardless of UI language. The
 * Enter keycap carries a visually hidden "Enter" so the option is not announced
 * as an unlabelled icon.
 */
export function SendKeyBadge({ value }: { value: SendKey }) {
  const enterKey = (
    <Kbd>
      <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">Enter</span>
    </Kbd>
  );

  if (value === 'enter') {
    return <span className="flex items-center gap-1">{enterKey}</span>;
  }

  return (
    <span className="flex items-center gap-1">
      <Kbd>{isMacPlatform() ? '⌘' : 'Ctrl'}</Kbd>
      <span className="text-muted-foreground">+</span>
      {enterKey}
    </span>
  );
}

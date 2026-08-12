import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Floating candidate list that sits above a composer.
 *
 * Intentionally presentational: it does not know about triggers, caret
 * positions or keyboard handling. The owning hook (`useSuggestionMenu`) owns
 * those, so the same surface can serve slash commands today and `@` mentions
 * tomorrow without growing a second implementation.
 *
 * The visual language mirrors the composer itself — rounded border, muted fill,
 * soft shadow — so the popup reads as an extension of the input rather than a
 * foreign overlay. Motion is limited to the open/close of the whole panel; the
 * active-row highlight is a colour change only, because a layout shift on every
 * arrow key would be the kind of micro-animation the design rules reject.
 */

export interface SuggestionItem {
  /** Stable identity for React keys and active-index tracking. */
  id: string;
  /** Primary label, typically the trigger itself (`/new`). */
  label: string;
  /** Secondary line — a description or the expansion phrase. */
  description?: string;
  /** Small trailing chip (`builtin`, a category, …). */
  badge?: string;
}

interface SuggestionPopupProps {
  open: boolean;
  items: SuggestionItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  className?: string;
}

export function SuggestionPopup({
  open,
  items,
  activeIndex,
  onHover,
  onSelect,
  className,
}: SuggestionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the highlighted row in view without forcing a jump on every keystroke:
  // `nearest` only scrolls when the row has left the visible band. jsdom does
  // not implement `scrollIntoView`, so it is guarded rather than stubbed.
  useEffect(() => {
    if (!open) return;
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  return (
    <AnimatePresence>
      {open && items.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className={cn(
            'absolute bottom-full left-0 right-0 z-30 mb-1.5',
            'overflow-hidden rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur-sm',
            className,
          )}
          // The popup is a visual extension of the input, not a focus target: the
          // textarea keeps the caret, and pointer events only select a row.
          role="listbox"
          aria-activedescendant={items[activeIndex] ? `suggestion-${items[activeIndex].id}` : undefined}
        >
          <div
            ref={listRef}
            className="max-h-[min(14rem,40vh)] overflow-y-auto scrollbar-lumo py-1"
          >
            {items.map((item, index) => {
              const active = index === activeIndex;
              return (
                <button
                  key={item.id}
                  id={`suggestion-${item.id}`}
                  ref={active ? activeRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={active}
                  // `onMouseDown` rather than `onClick`: a click would blur the
                  // textarea first, and the resulting caret jump can close the
                  // menu before the selection lands.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(index);
                  }}
                  onMouseEnter={() => onHover(index)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                    active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                  )}
                >
                  {/*
                    The label owns a fixed column, not a flex-1 half and not a
                    content-sized span. A content-sized label would let a long
                    command name push the description around; a flex-1 half
                    splits the space *after* the badge, so a wider badge
                    (Custom vs Built-in) shifts the description column between
                    rows. A fixed column pins the description start to the same
                    place on every row — the badge then occupies whatever is
                    left over on the right.
                  */}
                  <span className="w-[40%] shrink-0 truncate font-mono text-sm leading-tight">
                    {item.label}
                  </span>
                  {item.description && (
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs leading-tight',
                        active ? 'text-accent-foreground/70' : 'text-muted-foreground',
                      )}
                    >
                      {item.description}
                    </span>
                  )}
                  {item.badge && (
                    <span
                      className={cn(
                        'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none',
                        active
                          ? 'bg-accent-foreground/10 text-accent-foreground/80'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

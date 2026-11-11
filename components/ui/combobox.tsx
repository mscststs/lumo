import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Editable single-select combobox: a text field that both filters a list and
 * carries the value.
 *
 * Built for identifier fields whose option list comes from a remote and is
 * frequently in the hundreds — a plain `Select` forces scrolling, and a plain
 * `Input` gives up the list. Neither could do both, which is why call sites used
 * to swap between the two and lose free text entry the moment a list loaded.
 *
 * The value stays whatever the field holds: typing narrows the list *and* is a
 * legal value, so an id the provider has not listed yet is still enterable.
 *
 * Keyboard follows the ARIA 1.2 editable-combobox pattern — focus never leaves
 * the input, and the highlighted row is announced through
 * `aria-activedescendant`:
 *   ↓ / ↑   open the list, then move the highlight (wrapping)
 *   Enter   apply the highlighted row
 *   Esc     close the list only (the surrounding dialog stays open — the
 *           popover's dismissable layer is above the dialog's, so Radix
 *           consumes the key before the dialog sees it)
 *   Tab     close the list and leave the field
 */

export interface ComboboxOption {
  /** Stored value, also the row's primary label. */
  value: string;
  /** Row label. Defaults to `value` when omitted. */
  label?: string;
  /** Secondary text pinned to the trailing edge, e.g. a human-readable name. */
  description?: string;
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired after a row is picked, with that row, once the value has been set. */
  onSelect?: (option: ComboboxOption) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /** Copy shown when the query matches nothing. */
  emptyLabel: string;
  /** Accessible name of the list. */
  listLabel: string;
  /** Field wiring injected by `Field`. */
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  className?: string;
  /** Render the value in the code face. */
  mono?: boolean;
}

/**
 * Folds the separators model ids are spelled with inconsistently, so `gpt4o`
 * finds `gpt-4o` and `Qwen3_32B` finds `qwen3-32b`. Real gateways publish all
 * three spellings, and requiring the exact one is the difference between a
 * search box that works and one users stop trusting.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/[-_.\s]+/g, '');
}

export function Combobox({
  value,
  onChange,
  onSelect,
  options,
  placeholder,
  emptyLabel,
  listLabel,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  className,
  mono,
}: ComboboxProps) {
  const reactId = React.useId();
  const listId = `${reactId}-listbox`;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const [open, setOpen] = React.useState(false);
  /**
   * Whether the field text is acting as a filter. It only becomes true once the
   * user types after opening: on open the field holds the current value, and
   * treating that as a query would collapse the list to the selected row —
   * exactly the "I have to scroll to find anything" problem this replaces.
   */
  const [querying, setQuerying] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);

  const query = open && querying ? value : '';
  const filtered = React.useMemo(() => {
    const needle = fold(query);
    if (!needle) return options;
    return options.filter((option) =>
      fold(option.value).includes(needle)
      || fold(option.label ?? '').includes(needle)
      || fold(option.description ?? '').includes(needle),
    );
  }, [options, query]);

  // A shorter list can leave the highlight past its end (typing narrows it under
  // the cursor); parking on the first row keeps Enter meaningful.
  React.useEffect(() => {
    setActiveIndex((index) => (index < filtered.length ? index : 0));
  }, [filtered.length]);

  React.useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  /**
   * Escape is claimed at the window's capture phase, before React and before
   * Radix's layer handlers.
   *
   * Radix dismisses a layer on Escape from a `document` capture listener that
   * only the topmost layer keeps installed. A dialog already mounted underneath
   * installed its own when it was topmost, and window capture is the only phase
   * that always runs ahead of it — without this, the same key would close the
   * dialog underneath the list (and the two layers would race on
   * `defaultPrevented` rather than cooperate).
   */
  React.useEffect(() => {
    if (!open) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuerying(false);
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [open]);

  const openList = () => {
    if (open) return;
    // Seed the highlight on the current value so the list opens where the user
    // already is, not at the top of several hundred rows.
    const index = options.findIndex((option) => option.value === value);
    setActiveIndex(index >= 0 ? index : 0);
    setQuerying(false);
    setOpen(true);
    // Opening from the chevron would otherwise leave focus on that button and
    // the arrow keys would go nowhere.
    if (document.activeElement !== inputRef.current) inputRef.current?.focus();
  };

  const closeList = () => {
    setOpen(false);
    setQuerying(false);
  };

  const choose = (option: ComboboxOption) => {
    setQuerying(false);
    setOpen(false);
    if (option.value !== value) onChange(option.value);
    onSelect?.(option);
  };

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    setActiveIndex((index) => (index + delta + filtered.length) % filtered.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      // Only ever applies a row. While the list is closed the field keeps its
      // text, so Enter never silently rewrites a hand-typed id.
      const option = open ? filtered[activeIndex] : undefined;
      if (!option) return;
      event.preventDefault();
      choose(option);
      return;
    }
    if (event.key === 'Tab') closeList();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? openList() : closeList())}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef} className={cn('relative', className)}>
          <Input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={
              open && filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined
            }
            aria-autocomplete="list"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            value={value}
            onChange={(event) => {
              setQuerying(true);
              setActiveIndex(0);
              onChange(event.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            onClick={openList}
            placeholder={placeholder}
            // Trailing padding clears the chevron; `pe-9` keeps long ids from
            // running underneath it when the sidebar is narrow.
            className={cn('pe-9', mono && 'font-mono text-xs')}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={listLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            // Keeping focus in the field makes the chevron a pointer-only
            // affordance layered on a keyboard-complete control, rather than a
            // second focus stop that would leave the arrows dead.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (open ? closeList() : openList())}
            className="absolute end-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            <ChevronDown
              className={cn('h-4 w-4 transition-transform duration-150', open && 'rotate-180')}
            />
          </Button>
        </div>
      </PopoverAnchor>

      <PopoverContent
        // The popover is an extension of the field: focus stays in the input so
        // arrows and typing keep working, and closing must not yank it back.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          // Clicks on the field or its chevron are inside the control even
          // though they are outside the portal; dismissing on them would make
          // the list blink shut as soon as the user reached for it.
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
        className="p-1"
        // Radix renders popover content as an unnamed `dialog`. The combobox
        // semantics live on the input (expanded/controls/activedescendant), so
        // an extra landmark here would only add noise to the accessibility tree.
        role="presentation"
      >
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={listLabel}
          className="max-h-[min(16rem,40vh)] overflow-y-auto scrollbar-lumo"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</p>
          ) : (
            filtered.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <button
                  key={option.value}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  // Options are reached through the input's
                  // `aria-activedescendant`, never through the Tab order.
                  tabIndex={-1}
                  data-index={index}
                  data-active={active || undefined}
                  // `onMouseDown` rather than `onClick`: a click would blur the
                  // input first, and the resulting focus change closes the
                  // popover before the selection lands.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(option);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start transition-colors',
                    'data-[active]:bg-accent data-[active]:text-accent-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      mono && 'font-mono',
                    )}
                    dir="ltr"
                  >
                    {option.label ?? option.value}
                  </span>
                  {option.description && (
                    <span
                      className={cn(
                        'max-w-[45%] shrink-0 truncate text-[11px]',
                        active ? 'text-accent-foreground/70' : 'text-muted-foreground',
                      )}
                    >
                      {option.description}
                    </span>
                  )}
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

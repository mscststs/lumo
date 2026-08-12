import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  findActiveTrigger,
  replaceTriggerToken,
  type ActiveTrigger,
  type TriggerSpec,
} from '@/lib/input-trigger';
import type { SuggestionItem } from '@/components/ui/suggestion-popup';

/**
 * Headless state machine for a composer suggestion menu.
 *
 * Owns three things and nothing else:
 * 1. Whether a trigger is active at the current caret, and which items match.
 * 2. Keyboard navigation over those items (arrows, Tab, Enter, Esc).
 * 3. Applying a selection back into the surrounding text.
 *
 * The host component still owns the controlled input value: this hook never
 * mutates it itself, it only proposes a replacement through `onApply`. That
 * keeps it usable from any controlled textarea — chat composer today, a search
 * box tomorrow — without inventing a second source of truth.
 */

export interface SuggestionOption extends SuggestionItem {
  /**
   * Text written into the input in place of the active token.
   *
   * Distinct from `label` so the row can show `/new` while the insertion is
   * `/new ` (trailing space ready for the rest of the message).
   */
  insertText: string;
}

export interface UseSuggestionMenuOptions {
  value: string;
  /** Caret offset inside `value`. Host keeps this in sync via `onSelect`/`onChange`. */
  caret: number;
  triggers: readonly TriggerSpec[];
  /**
   * Produces the candidates for an active trigger. Called whenever the query
   * changes; returning `[]` closes the menu without residual empty chrome.
   */
  resolve: (trigger: ActiveTrigger) => SuggestionOption[];
  /** Commits a replacement: new value and the caret to place after it. */
  onApply: (next: { value: string; caret: number }) => void;
}

export interface SuggestionMenu {
  open: boolean;
  items: SuggestionOption[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /**
   * Keyboard handler. Returns `true` when the event was consumed, so the host
   * can skip its own Enter-to-send (or whatever else shares the key).
   */
  onKeyDown: (event: React.KeyboardEvent) => boolean;
  select: (index: number) => void;
  /** Closes the menu until the active token identity changes. */
  dismiss: () => void;
}

export function useSuggestionMenu({
  value,
  caret,
  triggers,
  resolve,
  onApply,
}: UseSuggestionMenuOptions): SuggestionMenu {
  const [activeIndex, setActiveIndex] = useState(0);
  // Bumped on dismiss so a ref-only change still re-renders and hides the menu.
  const [dismissVersion, setDismissVersion] = useState(0);
  // Identity of the token the user last dismissed with Esc. Matching it again
  // keeps the menu closed; any other token reopens it.
  const dismissedKeyRef = useRef<string | null>(null);

  const trigger = useMemo(
    () => findActiveTrigger(value, caret, triggers),
    [value, caret, triggers],
  );

  // Identity of the token+query the user last dismissed with Esc. Matching it
  // again keeps the menu closed; any other token *or query* reopens it, so
  // continuing to type after Esc brings the menu back (Slack-style) while a
  // same-query Esc stays dismissed.
  const triggerKey = trigger ? `${trigger.char}@${trigger.start}:${trigger.query}` : null;

  // A change of token identity clears a prior dismiss, so typing a fresh `/`
  // after Esc'ing a previous one reopens immediately.
  useEffect(() => {
    if (triggerKey === null || dismissedKeyRef.current !== triggerKey) {
      dismissedKeyRef.current = null;
    }
  }, [triggerKey]);

  const items = useMemo(() => {
    if (!trigger) return [] as SuggestionOption[];
    if (dismissedKeyRef.current === triggerKey) return [] as SuggestionOption[];
    return resolve(trigger);
    // `dismissVersion` is the re-render signal for a ref-only dismiss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, triggerKey, resolve, dismissVersion]);

  // Reset the highlight whenever the candidate set changes identity, so an
  // arrow-key selection made against a longer list cannot point past the end
  // of a shorter one.
  const itemsKey = items.map((item) => item.id).join('\0');
  useEffect(() => {
    setActiveIndex(0);
  }, [itemsKey, triggerKey]);

  const open = items.length > 0;
  const safeIndex = open ? Math.min(activeIndex, items.length - 1) : 0;

  const select = useCallback(
    (index: number) => {
      if (!trigger) return;
      const item = items[index];
      if (!item) return;
      dismissedKeyRef.current = null;
      onApply(replaceTriggerToken(value, trigger, item.insertText));
    },
    [trigger, items, onApply, value],
  );

  const dismiss = useCallback(() => {
    if (triggerKey) dismissedKeyRef.current = triggerKey;
    setDismissVersion((version) => version + 1);
  }, [triggerKey]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      if (!open) return false;

      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          setActiveIndex((current) => (current + 1) % items.length);
          return true;
        }
        case 'ArrowUp': {
          event.preventDefault();
          setActiveIndex((current) => (current - 1 + items.length) % items.length);
          return true;
        }
        case 'Tab': {
          event.preventDefault();
          setActiveIndex((current) =>
            event.shiftKey
              ? (current - 1 + items.length) % items.length
              : (current + 1) % items.length,
          );
          return true;
        }
        case 'Enter': {
          // Only bare Enter selects. Modifier+Enter is the host's to interpret
          // (newline under `sendKey: 'enter'`, send under `meta-enter`).
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
            return false;
          }
          event.preventDefault();
          select(safeIndex);
          return true;
        }
        case 'Escape': {
          event.preventDefault();
          dismiss();
          return true;
        }
        default:
          return false;
      }
    },
    [open, items.length, select, safeIndex, dismiss],
  );

  return {
    open,
    items,
    activeIndex: safeIndex,
    setActiveIndex,
    onKeyDown,
    select,
    dismiss,
  };
}

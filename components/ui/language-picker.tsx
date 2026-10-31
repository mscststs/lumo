import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Globe, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  detectLanguage,
  findLocale,
  sortLocalesForPicker,
  type LanguagePreference,
  type LocaleDescriptor,
} from '@/i18n/locales';

interface LanguagePickerProps {
  value: LanguagePreference;
  onChange: (value: LanguagePreference) => void;
  className?: string;
}

/**
 * Language selector for the personalisation page.
 *
 * A plain `Select` stops working around 55 entries: the menu is taller than the
 * viewport and has no way to search. This keeps the same trigger geometry as
 * every other setting (so it reads as one system) but opens a searchable list —
 * the pattern Chrome, VS Code and macOS all use once a language list gets long.
 *
 * The list is ordered by native name in the *active* language's collation, with
 * the current language and English pinned: users looking for their own language
 * should not have to scroll past 50 others.
 */
export function LanguagePicker({ value, onChange, className }: LanguagePickerProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const detected = findLocale(detectLanguage());
  const selected = value === 'auto' ? undefined : findLocale(value);
  const triggerLabel =
    value === 'auto'
      ? `${t('options.ui.languageAuto')}${detected ? ` · ${detected.native}` : ''}`
      : (selected?.native ?? value);

  const locales = useMemo(() => sortLocalesForPicker(i18n.language), [i18n.language]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return locales;
    return locales.filter((locale) =>
      [locale.native, locale.english, locale.tag, locale.chrome].some((field) =>
        field.toLowerCase().includes(needle)
      )
    );
  }, [locales, query]);

  // `auto` is always first: it is the default and the only option that is not a
  // language, so it must not be interleaved with the alphabetical list.
  const showAuto = !query.trim() || 'auto'.includes(query.trim().toLowerCase());

  const rows = useMemo(
    () => (showAuto ? [null, ...filtered] : filtered),
    [filtered, showAuto]
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const commit = (next: LanguagePreference) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setActiveIndex((index) => (index + delta + rows.length) % rows.length);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[activeIndex];
      commit(row ? (row.tag as LanguagePreference) : 'auto');
    }
  };

  const isSelected = (row: LocaleDescriptor | null) =>
    row ? row.tag === value : value === 'auto';

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label={t('options.ui.language')}
        className={cn(
          'h-10 w-56 justify-between gap-2 px-3 font-normal',
          className
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Globe className="h-4 w-4 shrink-0 opacity-60" />
          <span className="truncate text-sm" dir="auto">
            {triggerLabel}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-3 p-4">
          <DialogHeader>
            <DialogTitle>{t('options.ui.language')}</DialogTitle>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t('options.ui.languageSearch')}
              aria-label={t('options.ui.languageSearch')}
              className="h-9 ps-9"
            />
          </div>

          <div
            ref={listRef}
            role="listbox"
            aria-label={t('options.ui.language')}
            className="max-h-[min(50vh,420px)] overflow-y-auto scrollbar-lumo -mx-1 px-1"
          >
            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t('sidebar.history.noResults')}
              </p>
            ) : (
              rows.map((row, index) => {
                const selectedRow = isSelected(row);
                return (
                  <button
                    key={row?.tag ?? 'auto'}
                    type="button"
                    role="option"
                    aria-selected={selectedRow}
                    data-index={index}
                    data-active={index === activeIndex || undefined}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(row ? (row.tag as LanguagePreference) : 'auto')}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-start transition-colors',
                      'data-[active]:bg-accent data-[active]:text-accent-foreground'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm" dir="auto">
                        {row ? row.native : t('options.ui.languageAuto')}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground" dir="auto">
                        {row ? row.english : t('options.ui.languageAutoDesc')}
                      </span>
                    </span>
                    {selectedRow && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

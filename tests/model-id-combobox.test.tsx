/**
 * @vitest-environment jsdom
 *
 * Behavioural cover for the model-id combobox.
 *
 * The field replaced a `Select` for exactly one reason: the fetched list is
 * hundreds of rows long and could only be scrolled. The risks worth pinning
 * down are therefore (a) that the list is complete when it opens — filtering the
 * *current value* on open would leave a single row — (b) that typing narrows it
 * including the separator spellings gateways disagree on, and (c) that the
 * keyboard alone can reach and apply any row without leaving the input.
 */
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';

afterEach(cleanup);

const OPTIONS: ComboboxOption[] = [
  { value: 'gpt-4o', description: 'GPT-4o' },
  { value: 'gpt-4o-mini' },
  { value: 'claude-sonnet-4-5', description: 'Claude Sonnet 4.5' },
  { value: 'qwen3-32b' },
];

function renderCombobox(initialValue = 'gpt-4o') {
  const onChange = vi.fn();
  const onSelect = vi.fn();

  function Wrapper() {
    const [value, setValue] = useState(initialValue);
    return (
      <Combobox
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        onSelect={onSelect}
        options={OPTIONS}
        placeholder="model id"
        emptyLabel="no match"
        listLabel="search models"
      />
    );
  }

  render(<Wrapper />);
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { input, onChange, onSelect };
}

const rowValues = () =>
  screen.getAllByRole('option').map((row) => row.textContent);

describe('Combobox', () => {
  it('stays closed until the field is opened', () => {
    const { input } = renderCombobox();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click with the full list, not just the current value', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);

    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(rowValues()).toHaveLength(OPTIONS.length);
    // The selected row is marked without being the only row left.
    const selected = screen.getAllByRole('option').filter(
      (row) => row.getAttribute('aria-selected') === 'true',
    );
    expect(selected.map((row) => row.textContent)).toEqual(['gpt-4oGPT-4o']);
  });

  it('filters by a substring of the id', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'sonnet' } });

    expect(rowValues()).toEqual(['claude-sonnet-4-5Claude Sonnet 4.5']);
  });

  it('matches across the separators model ids are spelled with', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'gpt4o' } });

    expect(rowValues()).toEqual(['gpt-4oGPT-4o', 'gpt-4o-mini']);

    fireEvent.change(input, { target: { value: 'qwen3_32b' } });
    expect(rowValues()).toEqual(['qwen3-32b']);
  });

  it('filters by the display name as well as the id', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'claude sonnet' } });

    expect(rowValues()).toEqual(['claude-sonnet-4-5Claude Sonnet 4.5']);
  });

  it('keeps the highlight inside the list while filtering', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Narrowing below the highlight's index must not leave it out of range,
    // otherwise Enter would apply a row that is no longer on screen.
    fireEvent.change(input, { target: { value: 'qwen' } });
    const activeId = input.getAttribute('aria-activedescendant');
    expect(activeId).toBe(screen.getAllByRole('option')[0]!.id);
  });

  it('applies the highlighted row on Enter without leaving the field', () => {
    const { input, onChange, onSelect } = renderCombobox();
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith('claude-sonnet-4-5');
    expect(onSelect).toHaveBeenLastCalledWith(OPTIONS[2]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('wraps the highlight at both ends', () => {
    const { input, onChange } = renderCombobox();
    fireEvent.click(input);
    // Opens on the selected row (index 0); one step up wraps to the last row.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith('qwen3-32b');
  });

  it('applies a row on pointer down, before focus can move', () => {
    const { input, onChange, onSelect } = renderCombobox();
    fireEvent.click(input);
    fireEvent.mouseDown(screen.getAllByRole('option')[1]!);

    expect(onChange).toHaveBeenLastCalledWith('gpt-4o-mini');
    expect(onSelect).toHaveBeenLastCalledWith(OPTIONS[1]);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes the list on Escape while the field keeps its text', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'sonn' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    // The text is the value, not a throwaway query: a half-typed id survives so
    // a model the gateway does not list can still be entered by hand.
    expect(input.value).toBe('sonn');
  });

  it('shows the empty label but keeps the typed text usable', () => {
    const { input } = renderCombobox();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'unlisted-model' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('no match')).toBeTruthy();
    expect(input.value).toBe('unlisted-model');
  });

  it('toggles the list from the chevron', () => {
    const { input } = renderCombobox('gpt-4o');
    const chevron = screen.getByRole('button', { name: 'search models' });

    fireEvent.click(chevron);
    expect(screen.queryByRole('listbox')).not.toBeNull();
    // The chevron must not become a second focus stop: the arrows only work
    // from the field itself.
    expect(document.activeElement).toBe(input);

    fireEvent.click(chevron);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on ArrowDown for keyboard users', () => {
    const { input } = renderCombobox();
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(screen.queryByRole('listbox')).not.toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });
});

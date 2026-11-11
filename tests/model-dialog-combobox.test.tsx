/**
 * @vitest-environment jsdom
 *
 * Integration cover for the model dialog's id field.
 *
 * The field used to swap from an `Input` to a `Select` the moment the list
 * loaded, which meant the list could only be scrolled and a hand-typed id
 * became impossible. These tests pin the replacement to the dialog itself: the
 * fetched list is searchable, a picked row still prefills the name, and Escape
 * closes the list without closing the dialog.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
// The dialog's copy is translated, so the app's i18n instance has to exist here.
import '@/i18n';
import { ModelDialog } from '@/entrypoints/options/models/ModelDialog';
import type { ModelConfig } from '@/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DRAFT: ModelConfig = {
  id: 'm1',
  modelId: '',
  displayName: '',
  isVision: false,
};

const MODELS = {
  data: [
    { id: 'gpt-4o', display_name: 'GPT-4o', context_window: 128000 },
    { id: 'gpt-4o-mini' },
    { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
  ],
};

function renderDialog() {
  const onSave = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <ModelDialog
      draft={DRAFT}
      isExisting={false}
      providerName="Acme"
      providerBaseUrl="https://api.example.com/v1"
      providerApiKey="sk-test"
      providerType="openai-chat"
      providerVendor="custom"
      siblings={[]}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  return { onSave, onClose };
}

/** Renders the dialog, then loads the provider's model list through the button. */
async function fetchModels() {
  const { onSave, onClose } = renderDialog();
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => MODELS }));
  vi.stubGlobal('fetch', fetchMock);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  // The reasoning-effort control is a Radix Select, which also exposes
  // `role="combobox"`; the id field is addressed by its label instead.
  await waitFor(() =>
    expect(screen.getByLabelText(/model id/i).getAttribute('role')).toBe('combobox'),
  );
  const field = screen.getByLabelText(/model id/i) as HTMLInputElement;
  return { fetchMock, field: field as HTMLInputElement, onSave, onClose };
}

describe('model dialog id field', () => {
  it('turns the field into a searchable list once models are fetched', async () => {
    const { fetchMock, field } = await fetchModels();


    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } }),
    );

    fireEvent.click(field);
    expect(screen.getAllByRole('option')).toHaveLength(MODELS.data.length);

    fireEvent.change(field, { target: { value: 'mini' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toBe('gpt-4o-mini');
  });

  it('prefills the display name and window from the picked row', async () => {
    const { field } = await fetchModels();

    fireEvent.click(field);
    // `parseModelList` sorts by id, so `gpt-4o` is the second row here.
    const row = screen.getAllByRole('option').find((option) => option.textContent === 'gpt-4oGPT-4o');
    fireEvent.mouseDown(row!);

    expect(field.value).toBe('gpt-4o');
    expect((screen.getByLabelText(/display name/i) as HTMLInputElement).value).toBe('GPT-4o');
    // 128000 tokens arrives as a preset, so the field renders it, not "Custom".
    expect(screen.getByLabelText(/context window/i)).toBeTruthy();
  });

  it('closes only the list on Escape', async () => {
    const { field, onClose } = await fetchModels();

    fireEvent.click(field);
    expect(screen.queryByRole('listbox')).not.toBeNull();

    fireEvent.keyDown(field, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * The dialog is modal, so its scroll lock cancels every wheel event outside
   * its own node — and the list is portal'd to `body`, i.e. outside it. Unless
   * the panel registers as a lock of its own, the list can only be dragged by
   * its scrollbar. jsdom applies no stylesheet, so the geometry the lock
   * inspects is described explicitly here.
   */
  /**
   * A modal dialog sets `pointer-events: none` on `body` and re-enables it on
   * its own layer only. The panel is portal'd outside that layer, so without the
   * override it is not a hit-test target at all: the wheel lands on `<html>` and
   * neither scrolling nor clicking reaches the rows.
   */
  it('re-enables pointer events on the portalled panel', async () => {
    const { field } = await fetchModels();
    fireEvent.click(field);

    expect(screen.getByRole('listbox').parentElement?.style.pointerEvents).toBe('auto');
  });

  it('lets the wheel scroll the list inside the modal dialog', async () => {
    const { field } = await fetchModels();
    fireEvent.click(field);
    const list = screen.getByRole('listbox');

    list.style.overflowY = 'auto';
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });

    expect(fireEvent.wheel(list, { deltaY: 120, cancelable: true })).toBe(true);
  });

  it('keeps a hand-typed id that the fetched list does not contain', async () => {
    const { field } = await fetchModels();

    fireEvent.change(field, { target: { value: 'acme-internal-1' } });
    await waitFor(() => expect(screen.getByText(/no models match/i)).toBeTruthy());
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(field.value).toBe('acme-internal-1');
    expect((screen.getByLabelText(/display name/i) as HTMLInputElement).value).toBe(
      'acme-internal-1',
    );
  });
});

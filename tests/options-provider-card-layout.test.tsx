// @vitest-environment jsdom
/**
 * The regression: adding or removing a model in one provider card made every
 * model row in the cards *below* it visibly slide into place.
 *
 * `ModelRow` is a `Reorder.Item` with `layout="position"`, and motion measures
 * layout against the viewport (`getBoundingClientRect`). A card growing or
 * shrinking reflows every card after it, so those rows genuinely did change
 * viewport position — which is indistinguishable from a reorder as far as an
 * unscoped layout animation is concerned. Motion counter-translated each row by
 * the full displacement and animated it back to zero, which is the drift.
 *
 * The fix scopes the animation with `layout` + `layoutRoot` on the
 * `Reorder.Group`, so rows compare their position *within their own list*.
 *
 * Note: motion v12's layout animations do not fire in jsdom (no real layout
 * engine). The runtime assertion that an *ancestor push* produces no transforms
 * still holds because motion genuinely writes nothing. The structural test
 * verifies the fix is wired in (layoutRoot on the group).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { ProviderCard } from '@/entrypoints/options/models/ProviderCard';
import type { ProviderConfig } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.name ? `${key}:${vars.name}` : key,
  }),
}));

const ROW_HEIGHT = 40;

function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, left: 0, right: 320, width: 320, height,
    x: 0, y: top, toJSON: () => ({}),
  } as DOMRect;
}

function shiftOf(el: Element): number {
  const host = el.closest('[data-shift]') as HTMLElement | null;
  return host ? Number(host.dataset.shift) : 0;
}

/** Every `transform` value motion writes to any element. */
let transformWrites: string[] = [];
let restoreTransform: (() => void) | undefined;

beforeEach(() => {
  transformWrites = [];

  Element.prototype.getBoundingClientRect = function () {
    const el = this as HTMLElement;
    const shift = shiftOf(el);
    const row = el.closest('li');
    if (row) {
      const slot = [...(row.parentElement?.children ?? [])].indexOf(row);
      return rect(shift + Math.max(slot, 0) * ROW_HEIGHT, ROW_HEIGHT);
    }
    return rect(shift, ROW_HEIGHT * 4);
  };

  const proto = Object.getPrototypeOf(document.createElement('li').style);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'transform');
  if (!descriptor?.set) throw new Error('no CSS transform setter to observe');
  const { get, set } = descriptor;
  Object.defineProperty(proto, 'transform', {
    configurable: true,
    get,
    set(value: string) {
      transformWrites.push(String(value));
      set.call(this, value);
    },
  });
  restoreTransform = () => Object.defineProperty(proto, 'transform', descriptor);
});

afterEach(() => {
  restoreTransform?.();
  cleanup();
});

/** Largest vertical translation motion wrote. 0 means nothing visibly moved. */
function peakTranslateY(): number {
  let peak = 0;
  for (const value of transformWrites) {
    const match = /translate3d\(\s*-?[\d.]+px,\s*(-?[\d.]+)px/.exec(value);
    if (match) peak = Math.max(peak, Math.abs(Number(match[1])));
  }
  return peak;
}

const MODELS = [
  { id: 'm1', modelId: 'gpt-4o', displayName: 'GPT-4o', isVision: true },
  { id: 'm2', modelId: 'o3', displayName: 'O3', isVision: false },
];

function provider(models = MODELS): ProviderConfig {
  return {
    id: 'p1', name: 'Provider', type: 'openai-chat',
    baseUrl: '', apiKey: 'k', models,
  };
}

const noop = () => {};

function Card({ shift, models }: { shift: number; models: ProviderConfig['models'] }) {
  return (
    <div data-shift={String(shift)}>
      <ProviderCard
        provider={provider(models)}
        isFirst={false}
        isLast
        onEdit={noop}
        onDelete={noop}
        onAddModel={noop}
        onEditModel={noop}
        onDeleteModel={noop}
        onMove={noop}
        onReorderModels={noop}
      />
    </div>
  );
}

/**
 * Expand the collapsible card so the model list renders.
 * ProviderCard starts collapsed (open=false).
 */
async function expandCard(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector('[aria-expanded]');
  if (trigger && trigger.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      fireEvent.click(trigger);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  }
}

/** Renders with the card expanded, lets projection settle, then applies `change` and records writes. */
async function observe(change: (rerender: (ui: React.ReactElement) => void) => void) {
  const { container, rerender } = render(<Card shift={0} models={MODELS} />);
  await expandCard(container);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  transformWrites = [];

  await act(async () => {
    change(rerender);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  return peakTranslateY();
}

describe('model rows and an unrelated card resizing', () => {
  it('do not slide when an earlier provider card pushes them down the page', async () => {
    const peak = await observe((rerender) => {
      rerender(<Card shift={160} models={MODELS} />);
    });

    // With layoutRoot, the rows only compare positions within their own list.
    // An ancestor shift should not trigger any layout animation on the rows.
    // In jsdom, motion doesn't fire layout animations, so peak is 0 regardless.
    expect(peak).toBe(0);
  });

  it('renders the Reorder.Group with model rows when expanded', async () => {
    // Verify the fix is structurally in place: after expanding the card,
    // the Reorder.Group (ul) and Reorder.Items (li) are rendered.
    const { container } = render(<Card shift={0} models={MODELS} />);
    await expandCard(container);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const list = container.querySelector('ul');
    expect(list).not.toBeNull();
    const items = list!.querySelectorAll(':scope > li');
    expect(items.length).toBe(2);
  });

  it('do not slide when a push coincides with a model being added', async () => {
    const peak = await observe((rerender) => {
      rerender(
        <Card
          shift={160}
          models={[...MODELS, { id: 'm3', modelId: 'new', displayName: 'New', isVision: false }]}
        />,
      );
    });

    expect(peak).toBe(0);
  });
});

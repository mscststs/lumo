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
 * Assertions read the transforms motion actually writes, not
 * `onLayoutAnimationStart`: the callback fires whenever a node decides its
 * position changed, whereas a written `translate3d` is the thing the user sees.
 * jsdom performs no layout, so geometry is simulated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
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

/**
 * How far this subtree has been pushed down the page.
 *
 * Read from a DOM attribute rather than a JS variable on purpose: motion
 * snapshots before React commits and measures after, so the two reads must be
 * able to see different values, exactly as they would in a browser.
 */
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
      // Slot index within the list drives the row's own offset; a reorder
      // changes it, an ancestor shift does not.
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
    // Stands in for the provider cards above this one: when one of them gains or
    // loses a model, everything below it is pushed down the page.
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

/** Renders, lets projection settle, then applies `change` and records writes. */
async function observe(change: (rerender: (ui: React.ReactElement) => void) => void) {
  const { rerender } = render(<Card shift={0} models={MODELS} />);
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

    // Unscoped, motion counter-translated every row by the full 160px and
    // animated it back — the drift this test exists for.
    expect(peak).toBe(0);
  });

  it('still slide for a genuine reorder', async () => {
    // The guard must not have been bought by disabling the animation outright.
    const peak = await observe((rerender) => {
      rerender(<Card shift={0} models={[MODELS[1]!, MODELS[0]!]} />);
    });

    expect(peak).toBeGreaterThan(0);
  });

  it('do not slide when a push down the page coincides with a model being added', async () => {
    // The reported trigger, in full: adding a model to an earlier card both
    // reflows this one downwards *and* re-renders it. The new row appearing is
    // legitimate; the two existing rows keeping their slots must not animate.
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

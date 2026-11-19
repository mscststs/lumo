import { useMediaQuery } from '@/lib/use-media-query';

/**
 * Which interaction a floating disclosure has to support.
 *
 * `hover` — a fine pointer that can rest on a target. The surface may open on
 * hover/focus, the way a tooltip does.
 *
 * `tap` — a coarse pointer (finger, stylus without hover). Hover does not
 * exist, so anything that only opens on hover is unreachable (WCAG 1.4.13,
 * 2.1.1). The same content has to be reachable by tapping the trigger.
 *
 * The predicate is deliberately the one `reveal-on-hover` uses in
 * `assets/globals.css` — `(hover: hover) and (pointer: fine)` — so a control
 * that is visible on touch and a control that is *operable* on touch cannot
 * disagree about what kind of device this is. It answers for the **primary**
 * input device: a touchscreen laptop with a trackpad reports `hover`, and its
 * screen still cannot hover. `Hint` keeps the tap path as a plain click
 * exactly because of that (see `components/ui/hint.tsx`).
 */
export type PointerMode = 'hover' | 'tap';

const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

/**
 * Reads through `matchMedia` on every snapshot, so the value follows the device
 * (a tablet gaining a trackpad, a convertible folding shut). Without
 * `matchMedia` (jsdom, very old browsers) it falls back to `hover`: that is the
 * richer behaviour, and an environment that cannot report a pointer has no
 * hover to lose either.
 */
export function usePointerMode(): PointerMode {
  return useMediaQuery(HOVER_QUERY, true) ? 'hover' : 'tap';
}

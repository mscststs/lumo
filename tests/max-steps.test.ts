import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_STEPS,
  MIN_MAX_STEPS,
  STEPS_NEVER,
  isMaxStepsPreset,
  normalizeMaxSteps,
  stepAllowed,
} from '@/lib/max-steps';

/**
 * The cap is stored as a plain number with `0` standing for "no cap", so the
 * fragile part is everything that could turn that sentinel into a literal count:
 * a config written before the setting existed, a hand-edited export, or a
 * clamping rule applied in the wrong order. Any of those reading as "zero steps
 * allowed" would make every reply produce nothing at all.
 */

describe('normalizeMaxSteps', () => {
  it('defaults to no cap when nothing is stored', () => {
    // A config from a build that predates this setting must not acquire a cap.
    expect(normalizeMaxSteps(undefined)).toBe(STEPS_NEVER);
    expect(normalizeMaxSteps(null)).toBe(STEPS_NEVER);
    expect(normalizeMaxSteps('')).toBe(STEPS_NEVER);
    expect(DEFAULT_MAX_STEPS).toBe(STEPS_NEVER);
  });

  it('keeps the "never" sentinel rather than clamping it up to the minimum', () => {
    // The whole point of the sentinel: 0 is below MIN_MAX_STEPS, so a clamp that
    // ran before the sentinel check would silently impose a 10-step cap.
    expect(normalizeMaxSteps(0)).toBe(STEPS_NEVER);
  });

  it('treats anything non-numeric as no cap', () => {
    expect(normalizeMaxSteps('abc')).toBe(STEPS_NEVER);
    expect(normalizeMaxSteps(NaN)).toBe(STEPS_NEVER);
    expect(normalizeMaxSteps({})).toBe(STEPS_NEVER);
  });

  it('treats Infinity as no cap', () => {
    // Infinity is the intuitive way to hand-write "unlimited" in an exported
    // config, but `JSON.stringify` turns it into `null` on the way back out,
    // which is exactly why 0 is the stored representation instead.
    expect(normalizeMaxSteps(Infinity)).toBe(STEPS_NEVER);
    expect(normalizeMaxSteps(-Infinity)).toBe(STEPS_NEVER);
  });

  it('raises a positive cap below the minimum instead of honouring it', () => {
    // Only reachable via an imported or hand-edited config — the options page
    // clamps as you type. Honoured literally, a cap of 1 would truncate every
    // single turn and read as a broken extension rather than a strict setting.
    expect(normalizeMaxSteps(1)).toBe(MIN_MAX_STEPS);
    expect(normalizeMaxSteps(MIN_MAX_STEPS - 1)).toBe(MIN_MAX_STEPS);
  });

  it('reads a negative cap as no cap, not as the minimum', () => {
    expect(normalizeMaxSteps(-5)).toBe(STEPS_NEVER);
  });

  it('passes usable caps through, truncating fractions', () => {
    expect(normalizeMaxSteps(MIN_MAX_STEPS)).toBe(MIN_MAX_STEPS);
    expect(normalizeMaxSteps(250)).toBe(250);
    expect(normalizeMaxSteps(60.7)).toBe(60);
    // Strings are what a number input hands back.
    expect(normalizeMaxSteps('120')).toBe(120);
  });

  it('has no upper bound, since a very large cap is just "never" spelled out', () => {
    expect(normalizeMaxSteps(1_000_000)).toBe(1_000_000);
  });
});

describe('isMaxStepsPreset', () => {
  it('recognises the sentinel as a preset so the dropdown does not read "Custom"', () => {
    expect(isMaxStepsPreset(STEPS_NEVER)).toBe(true);
  });

  it('rejects a value that is not offered as a preset', () => {
    expect(isMaxStepsPreset(37)).toBe(false);
  });
});

describe('stepAllowed', () => {
  it('never runs out when uncapped', () => {
    // The sentinel is checked before the comparison; `step < 0` would otherwise
    // be false on the very first step and the turn would produce nothing.
    expect(stepAllowed(0, STEPS_NEVER)).toBe(true);
    expect(stepAllowed(10_000, STEPS_NEVER)).toBe(true);
  });

  it('allows exactly `maxSteps` steps', () => {
    expect(stepAllowed(0, 3)).toBe(true);
    expect(stepAllowed(2, 3)).toBe(true);
    expect(stepAllowed(3, 3)).toBe(false);
  });
});

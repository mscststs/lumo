/**
 * The paste threshold packs three user choices — never, a preset count, a custom
 * count — into one stored number, so the encoding has to be unambiguous. These
 * tests pin the two ends of it: `0` is the only value that means "never", and a
 * missing or junk value must not read as `0`.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PASTE_THRESHOLD,
  MAX_PASTE_THRESHOLD,
  PASTE_ALWAYS,
  PASTE_NEVER,
  PASTE_THRESHOLD_PRESETS,
  isPasteThresholdPreset,
  normalizePasteThreshold,
  shouldAttachPaste,
} from '@/lib/paste-threshold';
import { attachmentPreview, createTextAttachment } from '@/lib/text-attachment';

describe('normalizePasteThreshold', () => {
  it('falls back to the default for a value that was never stored', () => {
    // A config written before this setting existed. Reading it as 0 would
    // silently disable the feature for every upgrading user.
    expect(normalizePasteThreshold(undefined)).toBe(DEFAULT_PASTE_THRESHOLD);
    expect(normalizePasteThreshold(null)).toBe(DEFAULT_PASTE_THRESHOLD);
    expect(normalizePasteThreshold('nonsense')).toBe(DEFAULT_PASTE_THRESHOLD);
    expect(normalizePasteThreshold(NaN)).toBe(DEFAULT_PASTE_THRESHOLD);
  });

  it('keeps a stored count, including the never sentinel', () => {
    expect(normalizePasteThreshold(0)).toBe(PASTE_NEVER);
    expect(normalizePasteThreshold(500)).toBe(500);
    expect(normalizePasteThreshold('2500')).toBe(2500);
  });

  it('clamps a value that could not work as a threshold', () => {
    expect(normalizePasteThreshold(-10)).toBe(PASTE_NEVER);
    expect(normalizePasteThreshold(1e12)).toBe(MAX_PASTE_THRESHOLD);
    expect(normalizePasteThreshold(120.7)).toBe(120);
  });
});

describe('shouldAttachPaste', () => {
  it('never attaches when disabled', () => {
    expect(shouldAttachPaste('x'.repeat(10_000), PASTE_NEVER)).toBe(false);
  });

  it('attaches at the threshold, not one character before it', () => {
    expect(shouldAttachPaste('x'.repeat(499), 500)).toBe(false);
    expect(shouldAttachPaste('x'.repeat(500), 500)).toBe(true);
  });

  it('attaches any non-empty paste when always', () => {
    expect(shouldAttachPaste('x', PASTE_ALWAYS)).toBe(true);
    // An empty clipboard is not an attachment, whatever the setting says.
    expect(shouldAttachPaste('', PASTE_ALWAYS)).toBe(false);
  });
});

describe('preset detection', () => {
  it('recognises exactly the dropdown presets', () => {
    for (const preset of PASTE_THRESHOLD_PRESETS) {
      expect(isPasteThresholdPreset(preset)).toBe(true);
    }
    expect(isPasteThresholdPreset(1200)).toBe(false);
  });
});

describe('createTextAttachment', () => {
  it('collapses whitespace so a chip preview is not blank', () => {
    // A pasted document usually starts with a blank line and indentation; a
    // preview of that is invisible in a single-line chip.
    expect(attachmentPreview('\n\n   Hello    world\n\ttabbed')).toBe('Hello world tabbed');
  });

  it('strips markup from an HTML payload', () => {
    expect(attachmentPreview('<p>Hi <b>there</b></p>')).toBe('Hi there');
  });

  it('caps the preview well below the content length', () => {
    const attachment = createTextAttachment('y'.repeat(5_000), 'text/plain');
    expect(attachment.preview).toHaveLength(50);
    expect(attachment.content).toHaveLength(5_000);
    expect(attachment.id).toBeTruthy();
  });

  it('carries the caller-supplied semantics through', () => {
    const attachment = createTextAttachment('body', 'text/plain', { label: 'Pasted' });
    expect(attachment.label).toBe('Pasted');
    expect(attachment.mediaType).toBe('text/plain');
  });

  it('gives every attachment its own id', () => {
    const a = createTextAttachment('same', 'text/plain');
    const b = createTextAttachment('same', 'text/plain');
    expect(a.id).not.toBe(b.id);
  });
});

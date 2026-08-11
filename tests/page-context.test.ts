import { describe, it, expect } from 'vitest';
import {
  buildPageContextAttachment,
  formatPageContext,
  formatPageContextForModel,
  isPageContextAttachment,
  type PageContext,
} from '@/lib/page-context';

const CONTEXT: PageContext = {
  tabId: 42,
  title: 'Example Domain',
  url: 'https://example.com/docs?a=1',
};

describe('formatPageContext', () => {
  it('includes the tab id, title and url', () => {
    const text = formatPageContext(CONTEXT);
    expect(text).toContain('tabId: 42');
    expect(text).toContain('title: Example Domain');
    expect(text).toContain('url: https://example.com/docs?a=1');
  });

  it('stays clean for the UI card: no marker and no tool hint', () => {
    // The `[referenced browser tab]` marker and the tool-calling hint are model
    // only — they must not leak into the transcript's attachment card.
    const text = formatPageContext(CONTEXT);
    expect(text).not.toContain('[referenced browser tab]');
    expect(text).not.toContain('page_*');
    expect(text).not.toContain('Use tabId');
  });
});

describe('formatPageContextForModel', () => {
  it('marks the referenced browser tab and keeps the tool calling convention', () => {
    const text = formatPageContextForModel(CONTEXT);
    expect(text).toContain('[referenced browser tab]');
    expect(text).toContain('tabId: 42');
    expect(text).toMatch(/tabId 42/);
    expect(text).toContain('page_*');
    expect(text).toContain('Use tabId');
  });
});

describe('buildPageContextAttachment', () => {
  it('marks the attachment as page context and carries the given id and label', () => {
    const attachment = buildPageContextAttachment('id-1', CONTEXT, 'Page');
    expect(attachment.id).toBe('id-1');
    expect(attachment.kind).toBe('page-context');
    expect(attachment.label).toBe('Page');
    expect(attachment.mediaType).toBe('text/plain');
    expect(isPageContextAttachment(attachment)).toBe(true);
  });

  it('separates the clean content from the model-facing text', () => {
    const attachment = buildPageContextAttachment('id-1', CONTEXT, 'Page');
    // The card shows clean identity; the marker and hint are model only.
    expect(attachment.content).toBe(formatPageContext(CONTEXT));
    expect(attachment.content).not.toContain('[referenced browser tab]');
    expect(attachment.modelText).toBe(formatPageContextForModel(CONTEXT));
    expect(attachment.modelText).toContain('[referenced browser tab]');
  });

  it('previews the title, which is what fits a narrow sidebar chip', () => {
    expect(buildPageContextAttachment('id-1', CONTEXT, 'Page').preview).toBe('Example Domain');
  });

  it('falls back to the url when the page has no title', () => {
    // Untitled pages (raw files, some SPAs before hydration) must still show
    // something identifiable rather than an empty chip.
    const attachment = buildPageContextAttachment('id-1', { ...CONTEXT, title: '' }, 'Page');
    expect(attachment.preview).toBe(CONTEXT.url);
  });

  it('does not classify ordinary text attachments as page context', () => {
    expect(
      isPageContextAttachment({
        id: 'x',
        mediaType: 'text/plain',
        content: 'hello',
        preview: 'hello',
      }),
    ).toBe(false);
  });
});

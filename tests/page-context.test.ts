import { describe, it, expect } from 'vitest';
import {
  buildPageContextAttachment,
  formatPageContext,
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

  it('tells the model to pass the tab id to the page tools', () => {
    // This is the whole point of the attachment: without the calling convention
    // spelled out, the model guesses a tabId and operates on the wrong tab.
    const text = formatPageContext(CONTEXT);
    expect(text).toMatch(/tabId 42/);
    expect(text).toContain('page_*');
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

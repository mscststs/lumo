import { describe, it, expect } from 'vitest';
import { serializeAttachmentForModel } from '@/lib/attachment-serialization';
import { buildPageContextAttachment, type PageContext } from '@/lib/page-context';
import type { TextAttachment } from '@/types';

const CONTEXT: PageContext = {
  tabId: 42,
  title: 'Example Domain',
  url: 'https://example.com/docs?a=1',
};

describe('serializeAttachmentForModel', () => {
  it('prefers modelText and closes the block with a delimiter', () => {
    const attachment = buildPageContextAttachment('id-1', CONTEXT, 'Page');
    const out = serializeAttachmentForModel(attachment);
    expect(out).toBe(`${attachment.modelText}\n-----\n`);
    expect(out).toContain('[referenced browser tab]');
  });

  it('marks text attachments with a semantic marker', () => {
    const text: TextAttachment = {
      id: 't',
      mediaType: 'text/plain',
      content: 'hello world',
      preview: 'hello',
    };
    expect(serializeAttachmentForModel(text)).toBe('[text attachment]\nhello world\n-----\n');
  });

  it('wraps html content in an html marker', () => {
    const html: TextAttachment = {
      id: 'h',
      mediaType: 'text/html',
      content: '<p>hi</p>',
      preview: 'hi',
    };
    expect(serializeAttachmentForModel(html)).toBe('[HTML Content]\n<p>hi</p>\n-----\n');
  });

  it('marks file references as file attachments', () => {
    const fileRef: TextAttachment = {
      id: 'f',
      kind: 'file-ref',
      mediaType: 'text/plain',
      content: '[filename: report.pdf]',
      preview: 'report.pdf',
    };
    expect(serializeAttachmentForModel(fileRef)).toBe(
      '[file attachment]\n[filename: report.pdf]\n-----\n',
    );
  });
});
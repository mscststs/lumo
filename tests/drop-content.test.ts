import { describe, it, expect } from 'vitest';
import { classifyDroppedContent } from '@/lib/drop-content';

const PNG_DATA_URL = 'data:image/png;base64,AAA';

describe('classifyDroppedContent', () => {
  it('classifies pure text (no images) as a text drop', () => {
    const result = classifyDroppedContent('<span>Hello world</span>', 'Hello world');
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toBe('Hello world');
    }
  });

  it('classifies pure images (no text) as an image drop and extracts all sources', () => {
    const html =
      `<img src="${PNG_DATA_URL}">` +
      '<img src="https://example.com/2.png">' +
      '<div><img src="https://example.com/3.png"></div>';
    const result = classifyDroppedContent(html, '');
    expect(result.type).toBe('image');
    if (result.type === 'image') {
      expect(result.images).toHaveLength(3);
      expect(result.images![0]).toBe(PNG_DATA_URL);
    }
  });

  it('classifies mixed text + images as an HTML drop', () => {
    const html = `<span>some text</span><img src="${PNG_DATA_URL}"><span>more</span>`;
    const result = classifyDroppedContent(html, 'some text more');
    expect(result.type).toBe('html');
    if (result.type === 'html') {
      expect(result.html).toBe(html);
    }
  });

  it('does not treat img alt text as real content', () => {
    const html = `<img src="${PNG_DATA_URL}" alt="a photo">`;
    const result = classifyDroppedContent(html, '');
    expect(result.type).toBe('image');
  });

  it('falls back to textData when html is empty', () => {
    const result = classifyDroppedContent('', 'just text');
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toBe('just text');
    }
  });

  it('falls back to textData when html yields no extractable content', () => {
    const result = classifyDroppedContent('<div></div>', 'plain fallback');
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toBe('plain fallback');
    }
  });

  it('ignores script/style noise when extracting text', () => {
    const html = '<script>var x = 1;</script><p>Visible text</p><style>.a{}</style>';
    const result = classifyDroppedContent(html, 'Visible text');
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toBe('Visible text');
    }
  });
});

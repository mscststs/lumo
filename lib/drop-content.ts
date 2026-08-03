/**
 * Smart classification of content dragged from web pages into the sidebar.
 *
 * Drop payloads carry both `text/html` (the DOM fragment) and `text/plain`
 * (plain text). We parse the HTML fragment and classify it as one of:
 *   - pure text (no images)        -> text attachment
 *   - pure images (no text)        -> all image sources extracted
 *   - mixed text + images          -> preserved as an HTML attachment
 */

export interface DroppedContent {
  type: 'image' | 'html' | 'text';
  /** Original HTML fragment (for mixed-content drops and fallbacks). */
  html?: string;
  /** Plain text (for text-type drops). */
  text?: string;
  /** Extracted image sources (for image-type drops). */
  images?: string[];
}

export function classifyDroppedContent(htmlData: string, textData: string): DroppedContent {
  if (!htmlData?.trim()) {
    return { type: 'text', text: textData ?? '' };
  }

  const { images, text } = parseDroppedHtml(htmlData);

  if (images.length > 0 && text) {
    return { type: 'html', html: htmlData };
  }
  if (images.length > 0) {
    return { type: 'image', images, html: htmlData };
  }
  if (text) {
    return { type: 'text', text };
  }
  return { type: 'text', text: textData ?? '' };
}

export function parseDroppedHtml(html: string): { images: string[]; text: string } {
  const doc = parseDocument(html);
  if (doc) {
    const images = Array.from(doc.querySelectorAll('img'))
      .map((img) => img.getAttribute('src'))
      .filter((src): src is string => !!src);

    // Clone so img alt attributes / captions are not mistaken for real text.
    const clone = doc.cloneNode(true) as Document;
    clone.querySelectorAll('img, script, style, noscript, template').forEach((el) => el.remove());
    const text = (clone.body?.textContent ?? '').replace(/\s+/g, ' ').trim();

    return { images, text };
  }

  // Fallback regex parser for non-DOM environments (unit tests, SSR, etc.).
  const images: string[] = [];
  const imgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    if (match[1]) {
      images.push(match[1]);
    }
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();

  return { images, text };
}

function parseDocument(html: string): Document | null {
  try {
    if (typeof DOMParser === 'undefined') return null;
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

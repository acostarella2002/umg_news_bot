// RSS 2.0 builder (no dependency: a feed is a small, fixed XML shape).

// Escape text for XML and drop control characters that make XML invalid.
export const xmlEscape = (s) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex -- intentionally matches control characters in order to strip them
    .replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '') // remove chars forbidden in XML 1.0
    .replace(/&/g, '&amp;') // must be first
    .replace(/</g, '&lt;') // tags
    .replace(/>/g, '&gt;') // tags
    .replace(/"/g, '&quot;') // attribute safety
    .replace(/'/g, '&apos;'); // attribute safety

// Render one <item>: body as plain-text description, attachments appended as text lines.
const item = (n) => {
  const files = n.attachments.map((a) => `\n📎 ${a.name}: ${a.url}`).join(''); // attachments as readable lines
  const date = n.published || n.first_seen; // fall back to discovery time
  return `<item><title>${xmlEscape(n.title)}</title><link>${xmlEscape(n.url)}</link><guid isPermaLink="true">${xmlEscape(n.url)}</guid>${
    date ? `<pubDate>${new Date(date).toUTCString()}</pubDate>` : '' // RFC 822 date
  }<description>${xmlEscape((n.body || '') + files)}</description></item>`; // escaped plain text, never raw HTML
};

// Render a complete RSS document.
export const buildRss = ({ title, link, selfUrl, items }) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xmlEscape(title)}</title><link>${xmlEscape(link)}</link><description>${xmlEscape(
    `Avvisi: ${title}`, // channel description
  )}</description><language>it-it</language><atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml"/>${items.map(item).join('')}</channel></rss>`; // all items

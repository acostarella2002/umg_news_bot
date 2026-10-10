// Build the WhatsApp text for one notice (plain text with WhatsApp *bold* markup).

const MAX_BODY = 700; // excerpt length: enough to read, short enough for a chat

// Remove WhatsApp markup characters from scraped text so titles cannot break formatting.
const clean = (s) =>
  String(s ?? '')
    .replace(/[*_~`]/g, '')
    .trim(); // shortcut: also strips legit underscores, fine for notices

// Format a Rome-local date like "08/10/2026 18:57".
const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''; // empty when unknown

// Compose the message: header with the board name, title, date, excerpt, attachments, link.
export function formatNotice(notice, boardName) {
  const body = clean(notice.body); // plain text body
  const excerpt = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY).replace(/\s+\S*$/, '')}…` : body; // cut on a word boundary
  const lines = [
    `📢 *${clean(boardName)}*`, // which board the notice comes from
    `*${clean(notice.title)}*`, // notice title in bold
    fmtDate(notice.published) && `🗓️ ${fmtDate(notice.published)}`, // publication date
    excerpt && `\n${excerpt}`, // excerpt after a blank line
    notice.attachments?.length && `\n📎 *Allegati*\n${notice.attachments.map((a) => `• ${clean(a.name)}: ${a.url}`).join('\n')}`, // attachment links
    `\n🔗 ${notice.url}`, // original notice
  ];
  return lines.filter(Boolean).join('\n'); // drop empty parts
}

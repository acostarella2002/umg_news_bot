// Build the WhatsApp text for one notice from the editable template in config/message.json.
import { readFileSync } from 'node:fs'; // sync read is fine: runs once at startup
import { join } from 'node:path'; // portable path joining

// Placeholders a template may use; anything else is a typo and stops the bot at startup.
const KNOWN = ['bacheca', 'titolo', 'data', 'testo', 'allegati', 'link', 'nome', 'url'];

// Load and check a template object; throws with a readable message when it is broken.
export function checkTemplate(t) {
  if (!Array.isArray(t?.lines) || typeof t.attachment !== 'string' || !(t.maxBody > 0)) throw new Error('message.json: needs lines[], attachment, maxBody'); // shape
  const bad = [...t.lines, t.attachment]
    .join(' ')
    .match(/\{[^}]*\}/g)
    ?.filter((p) => !KNOWN.includes(p.slice(1, -1))); // unknown placeholders
  if (bad?.length) throw new Error(`message.json: unknown placeholders ${bad.join(', ')}`); // e.g. {titlo}
  return t; // valid
}

// Template shipped in config/ (copied into the Docker image with the sources).
export const template = checkTemplate(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'config', 'message.json'), 'utf8')));

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

// Replace {placeholders} in one pass (values containing "{…}" are never expanded again).
const fill = (line, v) => line.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// Compose the message: every template line, minus those whose placeholders are empty.
export function formatNotice(notice, boardName, t = template) {
  const body = clean(notice.body); // plain text body
  const v = {
    bacheca: clean(boardName), // which board the notice comes from
    titolo: clean(notice.title), // notice title
    data: fmtDate(notice.published), // publication date
    testo: body.length > t.maxBody ? `${body.slice(0, t.maxBody).replace(/\s+\S*$/, '')}…` : body, // excerpt cut on a word boundary
    allegati: (notice.attachments ?? []).map((a) => fill(t.attachment, { nome: clean(a.name), url: a.url })).join('\n'), // attachment links
    link: notice.url, // original notice
  };
  return t.lines
    .filter((l) => [...l.matchAll(/\{(\w+)\}/g)].every(([, k]) => v[k])) // drop lines with an empty part (no date, no body…)
    .map((l) => fill(l, v))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // dropped parts leave at most one blank line
    .trim();
}

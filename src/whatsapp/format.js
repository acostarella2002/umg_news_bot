// Build the WhatsApp text for one notice from the editable template in config/message.json.
import { readFileSync } from 'node:fs'; // sync read is fine: runs once at startup
import { join } from 'node:path'; // portable path joining

// Placeholders a template may use; anything else is a typo and stops the bot at startup.
const KNOWN_PLACEHOLDERS = ['bacheca', 'titolo', 'data', 'testo', 'allegati', 'link', 'nome', 'url'];
// Matches one {placeholder}.
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

// Check a template object; throws with a readable message when it is broken.
export function validateTemplate(template) {
  if (!Array.isArray(template?.lines) || typeof template.attachment !== 'string' || !(template.maxBody > 0))
    throw new Error('message.json: needs lines[], attachment, maxBody'); // shape
  const unknownPlaceholders = [...template.lines, template.attachment]
    .join(' ')
    .match(/\{[^}]*\}/g)
    ?.filter((placeholder) => !KNOWN_PLACEHOLDERS.includes(placeholder.slice(1, -1))); // typos
  if (unknownPlaceholders?.length) throw new Error(`message.json: unknown placeholders ${unknownPlaceholders.join(', ')}`); // e.g. {titlo}
  return template; // valid
}

// Template shipped in config/ (copied into the Docker image with the sources).
export const messageTemplate = validateTemplate(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'config', 'message.json'), 'utf8')));

// Remove WhatsApp markup characters from scraped text so titles cannot break formatting.
const stripWhatsAppMarkup = (text) =>
  String(text ?? '')
    .replace(/[*_~`]/g, '')
    .trim(); // shortcut: also strips legit underscores, fine for notices

// Format a Rome-local date like "08/10/2026 18:57".
const formatRomeDate = (isoDate) =>
  isoDate
    ? new Date(isoDate).toLocaleString('it-IT', {
        timeZone: 'Europe/Rome',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''; // empty when unknown

// Replace {placeholders} in one pass (values containing "{…}" are never expanded again).
const fillPlaceholders = (line, values) => line.replace(PLACEHOLDER_PATTERN, (_, name) => values[name] ?? '');

// Compose the message: every template line, minus those whose placeholders are empty.
export function formatNotice(notice, boardName, template = messageTemplate) {
  const body = stripWhatsAppMarkup(notice.body); // plain text body
  const values = {
    bacheca: stripWhatsAppMarkup(boardName), // which board the notice comes from
    titolo: stripWhatsAppMarkup(notice.title), // notice title
    data: formatRomeDate(notice.published), // publication date
    testo: body.length > template.maxBody ? `${body.slice(0, template.maxBody).replace(/\s+\S*$/, '')}…` : body, // excerpt cut on a word boundary
    allegati: (notice.attachments ?? [])
      .map((attachment) => fillPlaceholders(template.attachment, { nome: stripWhatsAppMarkup(attachment.name), url: attachment.url }))
      .join('\n'), // attachment links
    link: notice.url, // original notice
  };
  return template.lines
    .filter((line) => [...line.matchAll(PLACEHOLDER_PATTERN)].every(([, name]) => values[name])) // drop lines with an empty part (no date, no body…)
    .map((line) => fillPlaceholders(line, values))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // dropped parts leave at most one blank line
    .trim();
}

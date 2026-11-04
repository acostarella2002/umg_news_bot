// Parsers for the UMG school CMS (list + detail pages) and for RSS feeds.
import * as cheerio from 'cheerio'; // HTML/XML parsing

// Italian month names used by the DiGES card layout ("06 Ottobre 2026").
const ITALIAN_MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// Convert "DD/MM/YYYY HH:MM:SS" or "DD Mese YYYY" (Europe/Rome local time) to a UTC ISO string.
export function romeLocalToIso(dateText) {
  const longDateMatch = /(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i.exec(dateText || ''); // Italian long form
  const monthIndex = longDateMatch ? ITALIAN_MONTHS.indexOf(longDateMatch[2].toLowerCase()) : -1; // month number (0-based) or -1
  if (monthIndex >= 0) dateText = `${longDateMatch[1].padStart(2, '0')}/${String(monthIndex + 1).padStart(2, '0')}/${longDateMatch[3]}`; // rewrite to the numeric form
  const numericMatch = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(dateText || ''); // time part is optional
  if (!numericMatch) return null; // unparsable dates are left empty
  const [, day, month, year, hour = '00', minute = '00', second = '00'] = numericMatch; // captured parts with defaults
  const utcGuess = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)); // same wall time read as UTC
  const romeOffset =
    new Intl.DateTimeFormat('en', { timeZone: 'Europe/Rome', timeZoneName: 'longOffset' }) // ask Intl for Rome's offset
      .formatToParts(utcGuess) // split into parts to read the zone name
      .find((part) => part.type === 'timeZoneName')
      .value.replace('GMT', '') || '+00:00'; // "GMT+02:00" -> "+02:00"
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${romeOffset}`).toISOString(); // shortcut: offset sampled at the UTC guess, can be 1h off inside DST switch hours
}

// Some pages escape their text twice: without this, "&nbsp;" reaches the groups as written. Anything that is not a known entity stays as it is.
function decodeLeftoverEntities(text) {
  const decoded = text.replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, (entity) => cheerio.load(entity, null, false).root().text()); // one layer
  return decoded === text ? text : decodeLeftoverEntities(decoded); // ends: every change makes the text shorter
}
// One clean line of text, for titles and attachment names.
const cleanLine = (text) => decodeLeftoverEntities(text).replace(/\s+/g, ' ').trim();

// Turn an HTML fragment into readable plain text, keeping links as "text (url)".
export function htmlToText(html) {
  const $ = cheerio.load(html || '', null, false); // fragment mode, no <html> wrapper
  $('script, style').remove(); // never leak code into messages
  $('a[href]').each((_, link) => {
    const href = $(link).attr('href'); // link target
    const linkText = $(link).text().trim(); // visible link text
    if (/^https?:/i.test(href) && !linkText.includes(href)) $(link).text(linkText ? `${linkText} (${href})` : href); // expose the URL in text form
  });
  $('br').replaceWith('\n'); // line breaks
  $('p, div, li, tr, h1, h2, h3, h4').each((_, element) => void $(element).append('\n')); // block elements end with a newline
  return decodeLeftoverEntities($.root().text()) // decoded text content
    .replace(/\u00a0/g, ' ') // non-breaking spaces to normal spaces
    .replace(/[ \t]+/g, ' ') // collapse horizontal whitespace
    .replace(/ *\n */g, '\n') // trim around newlines
    .replace(/\n{3,}/g, '\n\n') // at most one empty line
    .trim(); // no leading/trailing blanks
}

// Parse a CMS list page (course or school "avvisi") into notice rows.
// allowedKinds: allowed URL kinds, e.g. ['avviso_didattica', 'avviso'] (skips staff-only 'avviso_personale').
export function parseList(html, pageUrl, allowedKinds = ['avviso_didattica', 'avviso']) {
  const $ = cheerio.load(html); // full document
  const noticesByUrl = new Map(); // keyed by URL to drop duplicate rows
  // Store one row if its link is an allowed kind and not seen yet.
  const addNotice = (link, published, updated) => {
    if (!link.length) return; // rows without a link (table headers)
    const url = new URL(link.attr('href'), pageUrl).href; // absolute URL
    const kind = /\/(avviso[a-z_]*)\/\d+\/?$/.exec(new URL(url).pathname)?.[1]; // e.g. "avviso_didattica"
    if (!allowedKinds.includes(kind) || noticesByUrl.has(url)) return; // wrong kind or already seen
    noticesByUrl.set(url, { url, title: cleanLine(link.text()), published, updated }); // single-line title
  };
  $('tr').each((_, row) => {
    const cells = $(row).find('td'); // table layout: published | title | updated
    addNotice($(row).find('a[href]').first(), romeLocalToIso(cells.eq(0).text()), romeLocalToIso(cells.eq(2).text())); // dates from columns 1 and 3
  });
  $('.avviso-item').each((_, card) => {
    const published = romeLocalToIso($(card).find('.news-data').text()); // card layout: "06 Ottobre 2026"
    addNotice($(card).find('.news-text a[href]').first(), published, null); // cards have no update date
  });
  return [...noticesByUrl.values()]; // array of notices
}

// Parse a notice detail page: body text and attachments (school CMS templates and the Ateneo site).
export function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html); // full document
  $('.jumbotron').find('h2, hr, small').remove(); // medicina/sfn: drop title and date footer, keep the (nested <p>) body
  const bodyElement = ['.jumbotron', 'div.my-5[style*="text-align:justify"]', '.col-md-9 div.text-justify']
    .map((selector) => $(selector).first())
    .find((element) => element.length); // medicina / sfn, diges, Ateneo
  const attachments = []; // [{ name, url }]
  $('a[href*="scarica_allegato"], #allegati_news a[href], .col-md-9 .well a[href]').each((_, link) => {
    const url = new URL($(link).attr('href'), pageUrl).href; // absolute URL
    if (/^https?:/.test(url) && !attachments.some((attachment) => attachment.url === url))
      // only web links, no duplicates
      attachments.push({ name: cleanLine($(link).text()) || 'Allegato', url }); // fallback label
  });
  return { body: htmlToText(bodyElement?.html() || ''), attachments }; // empty body when the template is unknown
}

// Parse an RSS 2.0 feed into notices (web.unicz.it and Fondazione UMG feeds).
export function parseRss(xml) {
  const $ = cheerio.load(xml, { xml: true }); // XML mode keeps <link> text
  return $('item')
    .map((_, item) => {
      const descriptionHtml = $(item).find('description').first().text(); // escaped/CDATA HTML, already decoded
      const description$ = cheerio.load(descriptionHtml, null, false); // parse the description HTML
      const attachments = description$('a[href]') // documents linked from the description
        .map((_, link) => ({ name: description$(link).text().trim() || 'Allegato', url: description$(link).attr('href') })) // label + link
        .get()
        .filter((attachment) => /^https?:/i.test(attachment.url)); // drop mailto/javascript links
      const publishedDate = new Date($(item).find('pubDate').text()); // RFC 822 date
      const url = $(item).find('link').first().text().trim(); // item permalink (dedup key)
      return {
        url,
        title: cleanLine($(item).find('title').first().text()), // titles may contain hard newlines
        published: Number.isNaN(publishedDate.getTime()) ? null : publishedDate.toISOString(), // ignore invalid dates
        updated: null, // RSS has no separate update date here
        body: /^https?:\/\/web\.unicz\.it\//i.test(url) ? null : htmlToText(descriptionHtml), // the Ateneo feeds hold only the first 400 characters, without line breaks: the text comes from the page
        attachments, // links found in the description
      };
    })
    .get()
    .filter((notice) => /^https?:/i.test(notice.url)); // items without a usable link are skipped
}

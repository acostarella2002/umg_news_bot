// Parsers for the UMG school CMS (list + detail pages) and for RSS feeds.
import * as cheerio from 'cheerio'; // HTML/XML parsing

// Italian month names used by the DiGES card layout ("06 Ottobre 2026").
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// Convert "DD/MM/YYYY HH:MM:SS" or "DD Mese YYYY" (Europe/Rome local time) to a UTC ISO string.
export function romeToIso(s) {
  const it = /(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i.exec(s || ''); // Italian long form
  const mIdx = it ? MONTHS.indexOf(it[2].toLowerCase()) : -1; // month number (0-based) or -1
  if (mIdx >= 0) s = `${it[1].padStart(2, '0')}/${String(mIdx + 1).padStart(2, '0')}/${it[3]}`; // rewrite to the numeric form
  const m = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s || ''); // time part is optional
  if (!m) return null; // unparsable dates are left empty
  const [, d, mo, y, h = '00', mi = '00', se = '00'] = m; // destructure captured parts with defaults
  const guess = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)); // same wall time read as UTC
  const tz =
    new Intl.DateTimeFormat('en', { timeZone: 'Europe/Rome', timeZoneName: 'longOffset' }) // ask Intl for Rome's offset
      .formatToParts(guess) // split into parts to read the zone name
      .find((p) => p.type === 'timeZoneName')
      .value.replace('GMT', '') || '+00:00'; // "GMT+02:00" -> "+02:00"
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${tz}`).toISOString(); // shortcut: offset sampled at the UTC guess, can be 1h off inside DST switch hours
}

// Turn an HTML fragment into readable plain text, keeping links as "text (url)".
export function htmlToText(html) {
  const $ = cheerio.load(html || '', null, false); // fragment mode, no <html> wrapper
  $('script, style').remove(); // never leak code into messages
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href'); // link target
    const text = $(a).text().trim(); // visible link text
    if (/^https?:/i.test(href) && !text.includes(href)) $(a).text(text ? `${text} (${href})` : href); // expose the URL in text form
  });
  $('br').replaceWith('\n'); // line breaks
  $('p, div, li, tr, h1, h2, h3, h4').each((_, el) => void $(el).append('\n')); // block elements end with a newline
  return $.root()
    .text() // decoded text content
    .replace(/\u00a0/g, ' ') // non-breaking spaces to normal spaces
    .replace(/[ \t]+/g, ' ') // collapse horizontal whitespace
    .replace(/ *\n */g, '\n') // trim around newlines
    .replace(/\n{3,}/g, '\n\n') // at most one empty line
    .trim(); // no leading/trailing blanks
}

// Parse a CMS list page (course or school "avvisi") into notice rows.
// kinds: allowed URL kinds, e.g. ['avviso_didattica', 'avviso'] (skips staff-only 'avviso_personale').
export function parseList(html, pageUrl, kinds = ['avviso_didattica', 'avviso']) {
  const $ = cheerio.load(html); // full document
  const out = new Map(); // keyed by URL to drop duplicate rows
  // Store one row if its link is an allowed kind and not seen yet.
  const add = (a, published, updated) => {
    if (!a.length) return; // rows without a link (table headers)
    const url = new URL(a.attr('href'), pageUrl).href; // absolute URL
    const kind = /\/(avviso[a-z_]*)\/\d+\/?$/.exec(new URL(url).pathname)?.[1]; // e.g. "avviso_didattica"
    if (!kinds.includes(kind) || out.has(url)) return; // wrong kind or already seen
    out.set(url, { url, title: a.text().replace(/\s+/g, ' ').trim(), published, updated }); // single-line title
  };
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td'); // table layout: published | title | updated
    add($(tr).find('a[href]').first(), romeToIso(tds.eq(0).text()), romeToIso(tds.eq(2).text())); // dates from columns 1 and 3
  });
  $('.avviso-item').each((_, card) => {
    const date = romeToIso($(card).find('.news-data').text()); // card layout: "06 Ottobre 2026"
    add($(card).find('.news-text a[href]').first(), date, null); // cards have no update date
  });
  return [...out.values()]; // array of notices
}

// Parse a notice detail page: body text and attachments (both CMS templates).
export function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html); // full document
  $('.jumbotron').find('h2, hr, small').remove(); // medicina/sfn: drop title and date footer, keep the (nested <p>) body
  const bodyEl = $('.jumbotron').first().length // medicina / sfn template
    ? $('.jumbotron').first()
    : $('div.my-5[style*="text-align:justify"]').first(); // diges template
  const attachments = []; // [{ name, url }]
  $('a[href*="scarica_allegato"], #allegati_news a[href]').each((_, a) => {
    const url = new URL($(a).attr('href'), pageUrl).href; // absolute URL
    if (/^https?:/.test(url) && !attachments.some((x) => x.url === url))
      // only web links, no duplicates
      attachments.push({ name: $(a).text().replace(/\s+/g, ' ').trim() || 'Allegato', url }); // fallback label
  });
  return { body: htmlToText(bodyEl.html() || ''), attachments }; // empty body when the template is unknown
}

// Parse an RSS 2.0 feed into notices (web.unicz.it and Fondazione UMG feeds).
export function parseRss(xml) {
  const $ = cheerio.load(xml, { xml: true }); // XML mode keeps <link> text
  return $('item')
    .map((_, it) => {
      const descHtml = $(it).find('description').first().text(); // escaped/CDATA HTML, already decoded
      const d$ = cheerio.load(descHtml, null, false); // parse the description HTML
      const attachments = d$('a[href]') // documents linked from the description
        .map((_, a) => ({ name: d$(a).text().trim() || 'Allegato', url: d$(a).attr('href') })) // label + link
        .get()
        .filter((x) => /^https?:/i.test(x.url)); // drop mailto/javascript links
      const pub = new Date($(it).find('pubDate').text()); // RFC 822 date
      return {
        url: $(it).find('link').first().text().trim(), // item permalink (dedup key)
        title: $(it).find('title').first().text().replace(/\s+/g, ' ').trim(), // titles may contain hard newlines
        published: Number.isNaN(pub.getTime()) ? null : pub.toISOString(), // ignore invalid dates
        updated: null, // RSS has no separate update date here
        body: htmlToText(descHtml), // plain text
        attachments, // links found in the description
      };
    })
    .get()
    .filter((n) => /^https?:/i.test(n.url)); // items without a usable link are skipped
}

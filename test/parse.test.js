// Unit tests for src/parse.js against real pages saved on 2026-10-09.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { readFileSync } from 'node:fs'; // fixture loading
import { romeLocalToIso, htmlToText, parseList, parseDetail, parseRss } from '../src/parse.js'; // module under test

// Read a fixture file as UTF-8 text (latin1 for the Fondazione feed, as the fetcher would decode it).
const fx = (name, enc = 'utf8') => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), enc);

// Rome dates are converted with the correct DST offset.
test('romeLocalToIso handles summer and winter time', () => {
  assert.equal(romeLocalToIso('08/10/2026 18:57:04'), '2026-10-08T16:57:04.000Z'); // CEST = UTC+2
  assert.equal(romeLocalToIso('15/01/2026 10:00:00'), '2026-01-15T09:00:00.000Z'); // CET = UTC+1
  assert.equal(romeLocalToIso('06 Ottobre 2026'), '2026-10-05T22:00:00.000Z'); // Italian long form, midnight in Rome
  assert.equal(romeLocalToIso('nonsense'), null); // invalid input
});

// HTML is flattened safely; scripts are removed and links become visible.
test('htmlToText strips scripts and keeps links', () => {
  const t = htmlToText('<p>Ciao<script>alert(1)</script> <a href="https://x.unicz.it/f">form</a></p><p>riga&nbsp;2</p>'); // sample fragment
  assert.equal(t, 'Ciao form (https://x.unicz.it/f)\nriga 2'); // expected plain text
});

// Text escaped twice by the site must not reach the groups as "&nbsp;", and normal text must not change.
test('htmlToText decodes entities left in the text', () => {
  assert.equal(htmlToText('<p>CdLM&amp;nbsp;in Psicologia</p>'), 'CdLM in Psicologia'); // the real case
  assert.equal(htmlToText('L&amp;#039;avviso &amp;egrave; &amp;#x41;'), "L'avviso è A"); // named and numeric
  assert.equal(htmlToText('Ricerca &amp; Sviluppo R&amp;D; prezzo 5&amp;euro'), 'Ricerca & Sviluppo R&D; prezzo 5&euro'); // no entity here: left alone
  assert.equal(htmlToText('Voce &amp;inesistente; qui'), 'Voce &inesistente; qui'); // unknown: left alone
  assert.equal(htmlToText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;'), '<script>alert(1)</script>'); // shown as plain text, never as markup: the RSS output escapes it
});

// Titles and attachment names go through the same cleaning.
test('titles and attachment names are decoded', () => {
  const [notice] = parseRss(
    '<rss><channel><item><title>Scorrimento&amp;amp;nbsp;CdLM\n  2026</title><link>https://www.fondazioneumg.it/n/1</link><description>Testo</description></item></channel></rss>',
  ); // escaped twice, as in the feeds
  assert.equal(notice.title, 'Scorrimento CdLM 2026'); // one clean line
  const [row] = parseList(
    "<table><tr><td></td><td><a href='/avviso_didattica/1'>Aula&amp;nbsp;5</a></td><td></td></tr></table>",
    'https://diges.unicz.it/avvisi',
  ); // list page
  assert.equal(row.title, 'Aula 5'); // same on the boards
});

// The Ateneo site: the whole text with its line breaks, the files in their boxes, nothing from the rest of the page.
test('parseDetail: Ateneo template', () => {
  const page = `<div class="col-md-3"><div class="well"><a href="/menu.pdf">Menu</a></div></div>
    <div class="col-md-9"><div class="row"><div class="col-xs-12">
      <h3 class="text-justify">Titolo</h3><hr>
      <div class="text-justify">Prima frase.<br>${'Seconda frase lunga. '.repeat(40)}</div>
      <div class="well well-sm"><h4><a href="/uploads/2026/08/primo-scorrimento.pdf">Primo&amp;nbsp;scorrimento</a></h4><small><em>Pubblicato in data: 01/08/2026</em></small></div>
      <div class="well well-sm"><h4><a href="/uploads/2026/09/secondo-scorrimento.pdf">Secondo scorrimento</a></h4></div>
    </div></div></div>
    <div class="footer"><a href="/admin/uploads/cookies.pdf">Informativa</a></div>`; // same shape as news/133089
  const detail = parseDetail(page, 'http://web.unicz.it/it/news/133089'); // parse
  assert.ok(detail.body.startsWith('Prima frase.\nSeconda frase lunga.')); // the line break the feed loses
  assert.ok(detail.body.length > 400); // more than the feed gives
  assert.ok(!detail.body.includes('Titolo')); // the heading is not the body
  assert.deepEqual(detail.attachments, [
    { name: 'Primo scorrimento', url: 'http://web.unicz.it/uploads/2026/08/primo-scorrimento.pdf' },
    { name: 'Secondo scorrimento', url: 'http://web.unicz.it/uploads/2026/09/secondo-scorrimento.pdf' },
  ]); // only the boxes of the article
  assert.deepEqual(parseDetail('<html></html>', 'http://web.unicz.it/it/news/1'), { body: '', attachments: [] }); // unknown template: empty, no crash
});

// Medicina course page (double-quoted table markup).
test('parseList: medicina course page', () => {
  const rows = parseList(fx('med-cds.html'), 'https://medicina.unicz.it/corso_studio/infermieristica/avvisi'); // parse
  const n = rows.find((r) => r.url === 'https://medicina.unicz.it/avviso_didattica/10258'); // known notice
  assert.ok(rows.length > 100); // full history is listed
  assert.equal(n.title, "AVVISO STUDENTI CONVEGNO 'OBESITA' DEL 12 OTTOBRE 2026"); // title text
  assert.equal(n.published, '2026-10-08T16:57:04.000Z'); // first column
  assert.equal(n.updated, '2026-10-08T16:57:27.000Z'); // third column
});

// DiGES course page (single-quoted, minified table markup).
test('parseList: diges course page', () => {
  const rows = parseList(fx('diges-cds.html'), 'https://diges.unicz.it/corso_studio/giurisprudenza/avvisi'); // parse
  assert.ok(rows.some((r) => r.url === 'https://diges.unicz.it/avviso_didattica/884')); // known notice present
  assert.ok(rows.every((r) => r.title && r.published)); // all rows complete
});

// SFN course page uses the same CMS.
test('parseList: sfn course page', () => {
  const rows = parseList(fx('sfn-cds.html'), 'https://www.sfn.unicz.it/corso_studio/farmacia/avvisi'); // parse
  assert.ok(rows.length > 50); // many notices
  assert.ok(rows.every((r) => r.url.startsWith('https://www.sfn.unicz.it/avviso'))); // absolute URLs on the right host
});

// School pages keep only general notices (no staff-only or per-course duplicates).
test('parseList: school page filters kinds', () => {
  const rows = parseList(fx('diges-school.html'), 'https://diges.unicz.it/avvisi', ['avviso']); // general notices only
  assert.ok(rows.length > 100); // plenty of rows
  assert.ok(rows.every((r) => /\/avviso\/\d+$/.test(r.url))); // no avviso_personale / avviso_didattica
});

// Medicina detail page: body text and attachment.
test('parseDetail: medicina template', () => {
  const d = parseDetail(fx('med-detail.html'), 'https://medicina.unicz.it/avviso_didattica/10258'); // parse
  assert.match(d.body, /Convegno sull'Obesità/); // body text extracted
  assert.match(d.body, /docs\.google\.com\/forms/); // inline link kept
  assert.deepEqual(d.attachments, [{ name: 'Convegno Prof Gnasso.pdf', url: 'https://medicina.unicz.it/scarica_allegato/16310' }]); // attachment
});

// DiGES detail page: body text, no attachments.
test('parseDetail: diges template', () => {
  const d = parseDetail(fx('diges-detail.html'), 'https://diges.unicz.it/avviso_didattica/884'); // parse
  assert.match(d.body, /seminari integrativi/); // body text extracted
  assert.deepEqual(d.attachments, []); // none on this notice
});

// web.unicz.it RSS feed.
test('parseRss: unicz feed', () => {
  const items = parseRss(fx('unicz-bacheca-studenti.xml')); // parse
  assert.ok(items.length >= 1); // at least one item
  assert.ok(items.every((i) => i.url.startsWith('http') && i.title && i.published)); // complete items
  assert.ok(items.every((i) => i.body === null)); // the feed holds a cut excerpt: the text comes from the page
});

// Fondazione UMG feed (ISO-8859-1, multi-line titles, PDF link in description).
test('parseRss: fondazione feed', () => {
  const items = parseRss(fx('fondazione-bandi.xml', 'latin1')); // decode as the fetcher does
  const first = items[0]; // newest item
  assert.ok(items.length > 10); // many bandi
  assert.ok(!first.title.includes('\n')); // newlines collapsed
  assert.match(first.title, /N° 1 POSTO/); // latin1 degree sign decoded
  assert.match(first.attachments[0].url, /\.pdf$/); // PDF attachment found
});

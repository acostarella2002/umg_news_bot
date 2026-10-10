// Unit tests for src/parse.js against real pages saved on 2026-10-09.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { readFileSync } from 'node:fs'; // fixture loading
import { romeToIso, htmlToText, parseList, parseDetail, parseRss } from '../src/parse.js'; // module under test

// Read a fixture file as UTF-8 text (latin1 for the Fondazione feed, as the fetcher would decode it).
const fx = (name, enc = 'utf8') => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), enc);

// Rome dates are converted with the correct DST offset.
test('romeToIso handles summer and winter time', () => {
  assert.equal(romeToIso('08/10/2026 18:57:04'), '2026-10-08T16:57:04.000Z'); // CEST = UTC+2
  assert.equal(romeToIso('15/01/2026 10:00:00'), '2026-01-15T09:00:00.000Z'); // CET = UTC+1
  assert.equal(romeToIso('06 Ottobre 2026'), '2026-10-05T22:00:00.000Z'); // Italian long form, midnight in Rome
  assert.equal(romeToIso('nonsense'), null); // invalid input
});

// HTML is flattened safely; scripts are removed and links become visible.
test('htmlToText strips scripts and keeps links', () => {
  const t = htmlToText('<p>Ciao<script>alert(1)</script> <a href="https://x.unicz.it/f">form</a></p><p>riga&nbsp;2</p>'); // sample fragment
  assert.equal(t, 'Ciao form (https://x.unicz.it/f)\nriga 2'); // expected plain text
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

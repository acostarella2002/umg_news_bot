// Unit tests for src/rss.js and src/server.js (real HTTP on a random local port).
import { test, before, after } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import * as cheerio from 'cheerio'; // used to check the produced XML parses
import { tmpdir } from 'node:os'; // a surely writable folder
import { openDb, upsertNotices, setStateValue } from '../src/db.js'; // storage
import { xmlEscape } from '../src/rss.js'; // escaping helper
import { createRssServer, computeHealth } from '../src/server.js'; // module under test

// Sources with one course and two feeds sharing the same id.
const sources = {
  courses: [{ id: 'giuri', name: 'Giurisprudenza', url: 'https://diges.unicz.it/x' }], // course
  schools: [], // none
  feeds: [
    { id: 'ateneo', name: 'Ateneo UMG - A', url: 'https://web.unicz.it/a' },
    { id: 'ateneo', name: 'Ateneo UMG - B', url: 'https://web.unicz.it/b' },
  ], // same id twice
};
let server, base; // shared across tests

// Start the server with one tricky notice in the DB.
before(async () => {
  const db = openDb(':memory:'); // fresh DB
  upsertNotices(
    db,
    'giuri',
    [
      {
        url: 'https://diges.unicz.it/avviso/1',
        title: 'A & B <script>',
        published: '2026-10-08T10:00:00.000Z',
        body: 'testo\u0001',
        attachments: [{ name: 'f.pdf', url: 'https://diges.unicz.it/f.pdf' }],
      },
    ],
    true,
  ); // special chars
  server = createRssServer({ db, sources, baseUrl: 'https://feeds.example' }).listen(0); // random port
  await new Promise((r) => server.once('listening', r)); // wait until bound
  base = `http://127.0.0.1:${server.address().port}`; // local URL
});
after(() => server.close()); // stop the server

// Escaping removes markup and invalid control characters.
test('xmlEscape', () => assert.equal(xmlEscape('<a&"\'>\u0001'), '&lt;a&amp;&quot;&apos;&gt;')); // all five entities, control char dropped

// Course feed is valid XML with escaped content and security headers.
test('GET /rss/giuri.xml', async () => {
  const r = await fetch(`${base}/rss/giuri.xml`); // request
  const xml = await r.text(); // body
  assert.equal(r.status, 200); // ok
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'"); // CSP present
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); // nosniff present
  assert.ok(!xml.includes('<script>')); // no raw markup injected
  const $ = cheerio.load(xml, { xml: true }); // parse back
  assert.equal($('item title').text(), 'A & B <script>'); // round-trips as text
  assert.match($('item description').text(), /f\.pdf: https/); // attachment line present
});

// Feed index lists deduplicated ids with absolute URLs.
test('GET /feeds', async () => {
  const list = await (await fetch(`${base}/feeds`)).json(); // JSON index
  assert.deepEqual(
    list.map((f) => f.id),
    ['all', 'giuri', 'ateneo'],
  ); // dedup of 'ateneo'
  assert.equal(list[1].rss, 'https://feeds.example/rss/giuri.xml'); // uses BASE_URL
});

// Unknown ids, traversal attempts and write methods are refused.
test('rejects unknown paths and methods', async () => {
  assert.equal((await fetch(`${base}/rss/nope.xml`)).status, 404); // unknown feed
  assert.equal((await fetch(`${base}/rss/..%2F..%2Fdata%2Fbot.db`)).status, 404); // traversal attempt
  assert.equal((await fetch(`${base}/rss/all.xml`, { method: 'POST' })).status, 405); // no writes
  assert.equal((await fetch(`${base}/health`)).status, 200); // health ok
});

// Health turns false when the data folder, the polls or WhatsApp need a human.
test('computeHealth', () => {
  const db = openDb(':memory:'); // fresh DB
  const t0 = Date.parse('2026-10-10T10:00:00Z'); // fixed clock
  const base = { db, dataDir: tmpdir(), pollMinutes: 15, startedAt: new Date(t0).toISOString(), whatsapp: 'connected' }; // healthy setup
  assert.equal(computeHealth({ ...base, now: t0 + 60_000 }).ok, true); // just started, no poll yet: grace period
  assert.equal(computeHealth({ ...base, now: t0 + 46 * 60_000 }).pollsRunning, false); // no poll for 3 cycles
  setStateValue(db, 'last_poll', new Date(t0 + 45 * 60_000).toISOString()); // a poll completed
  assert.equal(computeHealth({ ...base, now: t0 + 46 * 60_000 }).ok, true); // healthy again
  assert.equal(computeHealth({ ...base, now: t0 + 46 * 60_000, dataDir: './no/such/folder' }).dataWritable, false); // data folder missing
  for (const whatsapp of ['logged_out', 'replaced']) assert.equal(computeHealth({ ...base, now: t0 + 46 * 60_000, whatsapp }).ok, false); // needs a relink / a stray instance
  for (const whatsapp of ['reconnecting', 'error', 'disabled']) assert.equal(computeHealth({ ...base, now: t0 + 46 * 60_000, whatsapp }).ok, true); // recovers by itself
});

// An unhealthy status is served as 503, which Docker reads as "unhealthy".
test('GET /health returns 503 when not ok', async () => {
  const s = createRssServer({ db: openDb(':memory:'), sources, baseUrl: 'x', health: () => ({ ok: false, whatsapp: 'replaced' }) }).listen(0); // failing health
  await new Promise((r) => s.once('listening', r)); // wait until bound
  const r = await fetch(`http://127.0.0.1:${s.address().port}/health`); // request
  assert.equal(r.status, 503); // unhealthy
  assert.equal((await r.json()).whatsapp, 'replaced'); // reason visible
  s.close(); // stop
});

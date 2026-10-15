// Unit tests for src/poller.js with a fake fetcher (no network).
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, pendingDeliveries, linkGroup, getNotice } from '../src/db.js'; // storage helpers
import { pollOnce, buildJobs } from '../src/poller.js'; // module under test

// Tiny source set: one course, one school, one feed.
const sources = {
  courses: [{ id: 'giuri', school: 'diges', url: 'https://diges.unicz.it/corso_studio/giurisprudenza/avvisi' }], // course
  schools: [{ id: 'diges', url: 'https://diges.unicz.it/avvisi' }], // school
  feeds: [{ id: 'fondazione', url: 'https://www.fondazioneumg.it/feed' }], // RSS
};

// Build a table row like the CMS does.
const row = (id, title) =>
  `<tr><td>08/10/2026 10:00:00</td><td><a href='https://diges.unicz.it/avviso_didattica/${id}'>${title}</a></td><td>08/10/2026 10:00:00</td></tr>`;

// Fake fetcher serving in-memory pages; `pages` can be changed between polls.
const fakeFetch = (pages) => async (url) => {
  if (!(url in pages)) throw new Error(`HTTP 404 for ${url}`); // unknown page
  return pages[url]; // canned HTML/XML
};

// School notices are linked to the school and its courses.
test('buildJobs fans school notices out to its courses', () => {
  const school = buildJobs(sources).find((j) => j.url.endsWith('/avvisi') && !j.url.includes('corso_studio')); // school job
  assert.deepEqual(school.targets, ['diges', 'giuri']); // school + course
  const own = buildJobs(sources, (id) => id === 'diges').find((j) => j.url === school.url); // the school has its own group
  assert.deepEqual(own.targets, ['diges']); // no fan-out to the courses
});

// First poll seeds silently; second poll notifies only the new notice and fetches its detail.
test('pollOnce seeds then notifies new notices', async () => {
  const db = openDb(':memory:'); // fresh DB
  const pages = {
    [sources.courses[0].url]: `<table>${row(1, 'Vecchio')}</table>`, // existing notice
    [sources.schools[0].url]: '<html></html>', // empty school board
    [sources.feeds[0].url]: '<rss><channel></channel></rss>', // empty feed
    'https://diges.unicz.it/avviso_didattica/2': '<div class=\'my-5\' style="text-align:justify;"><p>Lezione annullata</p></div>', // detail page
  };
  const s1 = await pollOnce({ db, sources, fetchText: fakeFetch(pages), log: {} }); // first run
  assert.deepEqual(s1, { sources: 3, errors: 0, added: 1, details: 0 }); // seeded, no detail fetched
  linkGroup(db, 'giuri', 'g@g.us'); // admin maps a group
  pages[sources.courses[0].url] = `<table>${row(2, 'Nuovo')}${row(1, 'Vecchio')}</table>`; // a new notice appears
  const s2 = await pollOnce({ db, sources, fetchText: fakeFetch(pages), log: {} }); // second run
  assert.equal(s2.added, 1); // one new notice
  assert.equal(s2.details, 1); // its detail was fetched
  assert.equal(getNotice(db, 'https://diges.unicz.it/avviso_didattica/2').body, 'Lezione annullata'); // body stored
  assert.deepEqual(
    pendingDeliveries(db).map((p) => p.url),
    ['https://diges.unicz.it/avviso_didattica/2'],
  ); // only the new one is queued
});

// A failing board is counted and does not block the others.
test('pollOnce survives a broken source', async () => {
  const db = openDb(':memory:'); // fresh DB
  const warnings = []; // captured log calls
  const s = await pollOnce({ db, sources, fetchText: fakeFetch({}), log: { warn: (o) => warnings.push(o) } }); // every fetch fails
  assert.equal(s.errors, 3); // all three failed
  assert.ok(warnings.every((w) => Object.keys(w).join() === 'url,err')); // logs carry only URL + error
});

// An empty first read is not a seed, and a mass re-listing (site moved, URLs changed) is stored without notifying.
test('pollOnce guards against floods', async () => {
  const db = openDb(':memory:'); // fresh DB
  const warnings = []; // captured log calls
  const log = { warn: (o) => warnings.push(o) }; // logger
  const old = (id) => row(id, `T${id}`).replaceAll('08/10/2026', '08/10/2020'); // a notice published years ago
  const rows = (from, n) => Array.from({ length: n }, (_, i) => old(from + i)).join(''); // n old table rows
  const course = sources.courses[0].url; // the board under test
  linkGroup(db, 'giuri', 'g@g.us'); // group linked before anything is read
  const pages = { [course]: '<html>manutenzione</html>', [sources.schools[0].url]: '<html></html>', [sources.feeds[0].url]: '<rss></rss>' }; // maintenance page
  await pollOnce({ db, sources, fetchText: fakeFetch(pages), log }); // empty first read
  pages[course] = `<table>${rows(1, 30)}</table>`; // the real history appears
  await pollOnce({ db, sources, fetchText: fakeFetch(pages), log }); // this is the seed
  assert.equal(pendingDeliveries(db).length, 0); // history never sent
  pages[course] = `<table>${rows(101, 30)}</table>`; // every URL changed at once
  await pollOnce({ db, sources, fetchText: fakeFetch(pages), log }); // burst
  assert.equal(pendingDeliveries(db).length, 0); // not sent
  assert.ok(warnings.some((w) => /30 new notices at once: 0 recent/.test(w.err))); // but reported
  pages[course] = `<table>${row(200, 'Vero')}${rows(101, 30)}</table>`; // one genuine new notice
  await pollOnce({ db, sources, fetchText: fakeFetch(pages), log }); // normal cycle
  assert.deepEqual(
    pendingDeliveries(db).map((p) => p.url),
    ['https://diges.unicz.it/avviso_didattica/200'],
  ); // delivered as usual
});

// Many genuinely new notices at once are all queued (the sender then slows down), old re-listed ones are not.
test('pollOnce queues a real burst of recent notices', async () => {
  const db = openDb(':memory:'); // fresh DB
  const today = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }); // "10/10/2026"
  const recent = (id) => row(id, `R${id}`).replaceAll('08/10/2026', today); // published today
  const course = sources.courses[0].url; // the board under test
  const pages = { [course]: `<table>${row(1, 'Vecchio')}</table>`, [sources.schools[0].url]: '<html></html>', [sources.feeds[0].url]: '<rss></rss>' }; // seed
  await pollOnce({ db, sources, fetchText: fakeFetch(pages), log: {} }); // seed
  linkGroup(db, 'giuri', 'g@g.us'); // group linked
  const burst = Array.from({ length: 15 }, (_, i) => recent(300 + i)).join(''); // 15 notices published today
  const stale = row(400, 'Ripubblicato').replaceAll('08/10/2026', '01/01/2020'); // an old one re-listed in the same read
  pages[course] = `<table>${burst}${stale}${row(1, 'Vecchio')}</table>`;
  await pollOnce({ db, sources, fetchText: fakeFetch(pages), log: {} }); // burst
  const urls = pendingDeliveries(db, 3).map((p) => p.url); // queued
  assert.equal(urls.length, 15); // every recent notice is queued…
  assert.ok(!urls.includes('https://diges.unicz.it/avviso_didattica/400')); // …but not the stale one
});

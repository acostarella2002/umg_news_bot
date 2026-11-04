// Unit tests for src/poller.js with a fake fetcher (no network).
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, pendingDeliveries, linkGroup, getNotice } from '../src/db.js'; // storage helpers
import { pollOnce, buildJobs, findMovedUp } from '../src/poller.js'; // module under test

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
  assert.deepEqual(s1, { sources: 3, errors: 0, added: 1, details: 0, updates: 0 }); // seeded, no detail fetched
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

// Only a page that really climbed counts, whatever else happens to the list.
test('findMovedUp', () => {
  const moved = (previous, current) => findMovedUp([...previous], [...current]).join(''); // one letter = one page
  assert.equal(moved('ABCD', 'ABCD'), ''); // nothing changed
  assert.equal(moved('ABCD', 'DABC'), 'D'); // one edited page back on top
  assert.equal(moved('ABCD', 'BACD'), 'B'); // a small climb: B moved, not A
  assert.equal(moved('ABCD', 'CDAB'), 'CD'); // two edited pages
  assert.equal(moved('ABCD', 'XABCD'), 'X'); // a page outside the old list above the others: the caller drops it when it is unknown
  assert.equal(moved('ABCD', 'ABCDX'), ''); // a page entering at the bottom did not climb
  assert.equal(moved('ABCD', 'BCDA'), ''); // a page sinking moves nobody up
  assert.equal(moved('ABCD', 'ACD'), ''); // a page removed moves nobody up
  assert.equal(moved('', 'ABC'), ''); // no previous read: baseline only
  assert.equal(moved('ABC', ''), ''); // empty read
  assert.equal(moved('ABC', 'XYZ'), ''); // nothing in common: no base to compare with
});

const feedUrl = sources.feeds[0].url; // the feed under test
const page = (id) => `https://www.fondazioneumg.it/notizia/${id}`; // a page code in a feed carrying the whole text
// RSS document listing the given page codes, top first; `bodies` overrides the text of a page.
const feedOf = (ids, bodies = {}) =>
  `<rss><channel>${ids.map((id) => `<item><title>Avviso ${id}</title><link>${page(id)}</link><pubDate>Mon, 03 Aug 2026 10:00:00 GMT</pubDate><description>${bodies[id] ?? `Testo ${id}`}</description></item>`).join('')}</channel></rss>`;
// Make the stored pages old enough for an update: a fix right after publishing stays silent.
const agePages = (db) => db.prepare("UPDATE notices SET first_seen = '2026-01-01T00:00:00.000Z'").run();
// Poller on a fresh DB with the feed linked to a group.
const feedSetup = async (ids) => {
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'fondazione', 'g@g.us'); // group first
  const pages = { [sources.courses[0].url]: '<html></html>', [sources.schools[0].url]: '<html></html>', [feedUrl]: feedOf(ids) }; // only the feed has content
  const warnings = []; // captured log calls
  const poll = () => pollOnce({ db, sources, fetchText: fakeFetch(pages), log: { warn: (entry) => warnings.push(entry) } }); // one cycle
  await poll(); // seed and first order
  agePages(db); // as if the pages had been there for a while
  return { db, pages, warnings, poll };
};
const queuedUpdates = (db) => pendingDeliveries(db).filter((delivery) => delivery.isUpdate); // updates waiting to go
// Poller on a fresh DB with two feeds of one target, linked to a group, already seeded.
const twoFeedsSetup = async (firstFeed, secondFeed) => {
  const twoFeeds = { courses: [], schools: [], feeds: [feedUrl, `${feedUrl}2`].map((url) => ({ id: 'ateneo', url })) }; // same target
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'ateneo', 'g@g.us'); // group first
  const pages = { [feedUrl]: firstFeed, [`${feedUrl}2`]: secondFeed }; // what the site shows
  const poll = () => pollOnce({ db, sources: twoFeeds, fetchText: fakeFetch(pages), log: {} }); // one cycle
  await poll(); // seed
  return { db, pages, poll };
};

// A known code back on top of the feed: one update, with the new text; the feed read before it changes nothing.
test('a page moving up in a feed is queued as an update with its new text', async () => {
  const { db, pages, poll } = await feedSetup([1, 2, 3]); // seeded
  assert.equal((await poll()).updates, 0); // same order: nothing
  pages[feedUrl] = feedOf([3, 1, 2], { 3: 'Testo 3 con il nuovo scorrimento' }); // page 3 edited
  assert.equal((await poll()).updates, 1); // noticed
  assert.deepEqual(
    queuedUpdates(db).map((delivery) => delivery.url),
    [page(3)],
  ); // that code only
  assert.equal(getNotice(db, page(3)).body, 'Testo 3 con il nuovo scorrimento'); // the message will show the page as it is now
  assert.equal((await poll()).updates, 0); // the next read sees the same order: no repeat
  assert.equal(queuedUpdates(db).length, 1); // still one
});

// A brand new code on top is a new notice, and pushes the others down without moving them up.
test('a new notice is not an update', async () => {
  const { db, pages, poll } = await feedSetup([1, 2, 3]); // seeded
  pages[feedUrl] = feedOf([9, 1, 2, 3]); // new page
  const summary = await poll(); // one cycle
  assert.equal(summary.added, 1); // new
  assert.equal(summary.updates, 0); // not an update
  assert.deepEqual(
    pendingDeliveries(db).map((delivery) => [delivery.url, delivery.isUpdate]),
    [[page(9), 0]],
  ); // one normal message
});

// A new notice published in two categories shows in the second feed as an unknown-to-that-feed but stored page: not an update.
test('a new notice in two feeds of the same target is one message', async () => {
  const { db, pages, poll } = await twoFeedsSetup(feedOf([1, 2]), feedOf([3, 4])); // different pages
  pages[feedUrl] = feedOf([9, 1, 2]); // new page in the first category…
  pages[`${feedUrl}2`] = feedOf([9, 3, 4]); // …and in the second
  assert.equal((await poll()).updates, 0); // the second feed does not call it an update
  assert.equal(pendingDeliveries(db).length, 1); // one message
});

// One edit of a page listed in two feeds: one message.
test('one edit seen in two feeds is one update', async () => {
  const { db, pages, poll } = await twoFeedsSetup(feedOf([1, 2, 3]), feedOf([1, 2, 3])); // same pages
  agePages(db); // published long ago
  pages[feedUrl] = pages[`${feedUrl}2`] = feedOf([3, 1, 2]); // page 3 edited, both feeds change
  assert.equal((await poll()).updates, 1); // one, not two
  assert.equal(queuedUpdates(db).length, 1); // one message
});

// The first read after this feature arrives has no order to compare with, and an empty read must not lose it.
test('feed order: baseline, and an empty read keeps it', async () => {
  const { db, pages, poll } = await feedSetup([1, 2, 3]); // seeded
  db.prepare("DELETE FROM kv WHERE k LIKE 'order:%'").run(); // the state right after the deploy
  pages[feedUrl] = feedOf([3, 1, 2]); // different from before, but nobody knows
  assert.equal((await poll()).updates, 0); // baseline only
  pages[feedUrl] = '<rss></rss>'; // maintenance page
  await poll(); // empty read
  pages[feedUrl] = feedOf([2, 3, 1]); // back to normal, with a real edit made meanwhile
  assert.equal((await poll()).updates, 1); // noticed against the kept order
  assert.equal(queuedUpdates(db)[0].url, page(2)); // the right code
});

// A re-sorted site looks like every page edited: nothing is sent, the owner sees it in the logs.
test('many pages moving at once send nothing', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => index + 1); // 30 pages
  const { db, pages, warnings, poll } = await feedSetup(ids); // seeded
  pages[feedUrl] = feedOf([...ids].reverse()); // the whole list upside down
  assert.equal((await poll()).updates, 0); // no flood
  assert.equal(queuedUpdates(db).length, 0); // nothing queued
  assert.ok(warnings.some((warning) => /29 pages changed at once: no update sent/.test(warning.err))); // but reported
  assert.equal((await poll()).updates, 0); // and the new order is the base from now on
});

// Boards: the code is the same, the "updated" column moves forward.
test('a later update date on a board is an update with a fresh body', async () => {
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'giuri', 'g@g.us'); // group first
  const course = sources.courses[0].url; // the board
  const detail = 'https://diges.unicz.it/avviso_didattica/1'; // the page of the notice
  const line = (updated) => `<table><tr><td>08/10/2026 10:00:00</td><td><a href='${detail}'>Scorrimenti</a></td><td>${updated}</td></tr></table>`; // one row
  const pages = { [course]: line('08/10/2026 10:00:00'), [sources.schools[0].url]: '<html></html>', [feedUrl]: '<rss></rss>' }; // seed
  const warnings = []; // captured log calls
  const poll = () => pollOnce({ db, sources, fetchText: fakeFetch(pages), log: { warn: (entry) => warnings.push(entry) } }); // one cycle
  await poll(); // seed
  assert.equal((await poll()).updates, 0); // same date: nothing
  pages[course] = line('09/10/2026 10:00:00'); // edited, but seen right after the first sighting
  assert.equal((await poll()).updates, 0); // a fix just after publishing stays silent
  agePages(db); // published long ago
  pages[course] = line('08/10/2026 09:00:00'); // an older date, e.g. another board disagreeing
  assert.equal((await poll()).updates, 0); // not an update
  assert.equal(getNotice(db, detail).updated, '2026-10-09T08:00:00.000Z'); // and the stored date does not go back
  pages[course] = line('10/10/2026 10:00:00'); // edited again
  pages[detail] = '<div class=\'my-5\' style="text-align:justify;"><p>Nuovo scorrimento</p></div>'; // new text on the page
  assert.equal((await poll()).updates, 1); // announced
  assert.equal(getNotice(db, detail).body, 'Nuovo scorrimento'); // with the fresh text
  assert.equal(queuedUpdates(db).length, 1); // queued even though the body of the seed was empty
  db.prepare("UPDATE notice_updates SET at = '2026-01-01T00:00:00.000Z'").run(); // long after that
  delete pages[detail]; // the page is down this time
  pages[course] = line('11/10/2026 10:00:00'); // edited again
  assert.equal((await poll()).updates, 1); // the group is still told
  assert.equal(getNotice(db, detail).body, 'Nuovo scorrimento'); // and the old text is not lost
  assert.ok(warnings.some((warning) => warning.url === detail)); // the failure is logged
});

// A board row with the given update date, for a notice of the given kind.
const boardRow = (path, updated) =>
  `<table><tr><td>08/10/2026 10:00:00</td><td><a href='https://diges.unicz.it/${path}'>Avviso</a></td><td>${updated}</td></tr></table>`;

// The old fan-out left the courses on the school notices: an edit must reach the school group only (rule B12), not 26 groups.
test('the update of a school notice skips the courses of the old fan-out', async () => {
  const db = openDb(':memory:'); // fresh DB
  const school = sources.schools[0].url; // the board under test
  const pages = { [sources.courses[0].url]: '<html></html>', [school]: boardRow('avviso/1', '08/10/2026 10:00:00'), [feedUrl]: '<rss></rss>' }; // read while the school had no group
  const poll = () => pollOnce({ db, sources, fetchText: fakeFetch(pages), log: {} }); // one cycle
  await poll(); // the notice now has the school and the course as targets
  linkGroup(db, 'giuri', 'course@g.us'); // course group
  linkGroup(db, 'diges', 'school@g.us'); // the school gets its own group
  agePages(db); // published long ago
  pages[school] = boardRow('avviso/1', '09/10/2026 10:00:00'); // edited
  assert.equal((await poll()).updates, 1); // noticed
  assert.deepEqual(
    queuedUpdates(db).map((delivery) => delivery.jid),
    ['school@g.us'],
  ); // the course group is not told
});

// One page shared by two course boards: both groups are told, once, even though the first board moves the stored date.
test('the update of a page on two boards reaches both groups once', async () => {
  const twoCourses = { courses: ['a', 'b'].map((id) => ({ id, school: 'diges', url: `https://diges.unicz.it/${id}/avvisi` })), schools: [], feeds: [] }; // two boards
  const db = openDb(':memory:'); // fresh DB
  const pages = Object.fromEntries(twoCourses.courses.map(({ url }) => [url, boardRow('avviso_didattica/1', '08/10/2026 10:00:00')])); // the same row twice
  const poll = () => pollOnce({ db, sources: twoCourses, fetchText: fakeFetch(pages), log: {} }); // one cycle
  await poll(); // seed
  linkGroup(db, 'a', 'a@g.us'); // first group
  linkGroup(db, 'b', 'b@g.us'); // second group
  agePages(db); // published long ago
  for (const { url } of twoCourses.courses) pages[url] = boardRow('avviso_didattica/1', '09/10/2026 10:00:00'); // edited
  assert.equal((await poll()).updates, 1); // one update…
  assert.deepEqual(
    queuedUpdates(db)
      .map((delivery) => delivery.jid)
      .sort(),
    ['a@g.us', 'b@g.us'],
  ); // …for both groups
});

// The Ateneo feeds hold only a cut excerpt: the group must get the whole text, read from the page.
const ateneoPage = (id) => `http://web.unicz.it/it/news/${id}`; // a page code in the Ateneo feeds
const ateneoFeedOf = (ids) =>
  `<rss><channel>${ids.map((id) => `<item><title>Avviso ${id}</title><link>${ateneoPage(id)}</link><pubDate>Mon, 03 Aug 2026 10:00:00 GMT</pubDate><description><![CDATA[Testo tagliato dal sito attr...]]></description></item>`).join('')}</channel></rss>`;
const ateneoDetail = (text, file) =>
  `<div class="col-md-9"><div class="text-justify">${text}</div><div class="well well-sm"><h4><a href="/uploads/${file}.pdf">File</a></h4></div></div>`;
// Poller on a fresh DB with one Ateneo feed linked to a group, already seeded.
const ateneoSetup = async (ids) => {
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'ateneo', 'g@g.us'); // group first
  const pages = { [feedUrl]: ateneoFeedOf(ids) }; // what the site shows
  const fetched = []; // pages really downloaded
  const fetchText = async (url) => {
    fetched.push(url); // recorded
    return fakeFetch(pages)(url); // canned page
  };
  const poll = () => pollOnce({ db, sources: { courses: [], schools: [], feeds: [{ id: 'ateneo', url: feedUrl }] }, fetchText, log: {} }); // one cycle
  await poll(); // seed
  return { db, pages, fetched, poll };
};

// A new Ateneo notice waits for its page and is sent with the whole text; the seed downloads no page.
test('a new Ateneo notice takes the whole text from its page', async () => {
  const { db, pages, fetched, poll } = await ateneoSetup([1, 2]); // seeded
  assert.deepEqual(fetched, [feedUrl]); // only the feed: 50 pages at every seed would be rude
  assert.equal(getNotice(db, ateneoPage(1)).body, null); // no cut excerpt stored
  pages[feedUrl] = ateneoFeedOf([9, 1, 2]); // new notice
  pages[ateneoPage(9)] = ateneoDetail(`Inizio.<br>${'parola '.repeat(200)}fine`, 'bando'); // its page
  await poll(); // one cycle
  const notice = getNotice(db, ateneoPage(9)); // what the message will use
  assert.ok(notice.body.startsWith('Inizio.\nparola')); // whole text, with its line break
  assert.ok(notice.body.endsWith('fine')); // not cut
  assert.ok(!notice.body.includes('attr...')); // nothing from the excerpt
  assert.deepEqual(
    notice.attachments.map((attachment) => attachment.url),
    ['http://web.unicz.it/uploads/bando.pdf'],
  ); // the files of the page
  assert.equal(pendingDeliveries(db).length, 1); // ready to go
});

// A page that cannot be read still ends in a message (title and link), as for the school boards.
test('a new Ateneo notice whose page fails is sent with title and link', async () => {
  const { db, pages, poll } = await ateneoSetup([1]); // seeded
  pages[feedUrl] = ateneoFeedOf([9, 1]); // new notice, its page is down
  await poll(); // one cycle
  assert.equal(getNotice(db, ateneoPage(9)).body, ''); // given up, not retried forever
  assert.equal(pendingDeliveries(db).length, 1); // still goes
});

// An edited Ateneo page: the update shows the page as it is now; if the page is down, the old text stays.
test('the update of an Ateneo page reads the page again', async () => {
  const { db, pages, poll } = await ateneoSetup([1, 2, 3]); // seeded
  agePages(db); // published long ago
  pages[feedUrl] = ateneoFeedOf([3, 1, 2]); // page 3 edited
  pages[ateneoPage(3)] = ateneoDetail('Terzo scorrimento pubblicato', 'terzo'); // new text
  assert.equal((await poll()).updates, 1); // announced
  assert.equal(getNotice(db, ateneoPage(3)).body, 'Terzo scorrimento pubblicato'); // from the page, not the excerpt
  db.prepare("UPDATE notice_updates SET at = '2026-01-01T00:00:00.000Z'").run(); // long after that
  pages[feedUrl] = ateneoFeedOf([2, 3, 1]); // page 2 edited too
  assert.equal((await poll()).updates, 1); // its page is down, the group is still told
  assert.equal(getNotice(db, ateneoPage(2)).body, null); // nothing invented
  assert.equal(getNotice(db, ateneoPage(3)).body, 'Terzo scorrimento pubblicato'); // the other page is untouched
});

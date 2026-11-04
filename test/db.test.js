// Unit tests for src/db.js using an in-memory database.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import * as db from '../src/db.js'; // module under test

// Sample notice factory.
const n = (id, extra = {}) => ({
  url: `https://medicina.unicz.it/avviso_didattica/${id}`,
  title: `T${id}`,
  published: '2026-10-08T10:00:00.000Z',
  updated: null,
  ...extra,
});

// Upsert counts new rows, dedups by URL and links several targets to one notice.
test('upsertNotices dedups and links targets', () => {
  const d = db.openDb(':memory:'); // fresh DB
  assert.equal(db.upsertNotices(d, 'infermieristica', [n(1), n(2)], true), 2); // two new
  assert.equal(db.upsertNotices(d, 'fisioterapia', [n(2), n(3)], true), 1); // only #3 is new
  const targets = d
    .prepare('SELECT target FROM notice_targets WHERE url = ? ORDER BY target')
    .all(n(2).url)
    .map((r) => r.target); // links of #2
  assert.deepEqual(targets, ['fisioterapia', 'infermieristica']); // shared notice
});

// Seeded notices (notify=0) are never delivered; new ones after mapping are.
test('pendingDeliveries respects seed flag and mapping time', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.upsertNotices(d, 'infermieristica', [n(1, { body: 'x' })], false); // seeded on first run
  db.linkGroup(d, 'infermieristica', '123@g.us'); // group mapped after the seed
  db.upsertNotices(d, 'infermieristica', [n(2, { body: 'y' })], true); // genuinely new notice
  const p = db.pendingDeliveries(d); // what should be sent
  assert.deepEqual(
    p.map((r) => r.url),
    [n(2).url],
  ); // only the new one
  db.recordDelivery(d, n(2).url, '123@g.us', 'sent'); // mark as sent
  assert.equal(db.pendingDeliveries(d).length, 0); // nothing left
  assert.equal(db.countSentLastHour(d), 1); // rate counter sees it
});

// A notice linked to two targets mapped to the same group is sent once to that group.
test('pendingDeliveries sends once per group', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.linkGroup(d, 'medicina', 'g1@g.us'); // school target
  db.linkGroup(d, 'infermieristica', 'g1@g.us'); // course target, same group
  db.upsertNotices(d, 'medicina', [n(5, { body: '' })], true); // school notice
  db.upsertNotices(d, 'infermieristica', [n(5, { body: '' })], true); // also listed on the course
  assert.equal(db.pendingDeliveries(d).length, 1); // one message only
});

// Notices without body wait for the detail page (but not forever).
test('pendingDeliveries waits for detail body', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.linkGroup(d, 'infermieristica', 'g@g.us'); // mapping first
  db.upsertNotices(d, 'infermieristica', [n(7)], true); // body still NULL
  assert.equal(db.pendingDeliveries(d).length, 0); // held back
  assert.deepEqual(
    db.noticesNeedingDetail(d, 10).map((r) => r.url),
    [n(7).url],
  ); // detail requested
  db.saveDetail(d, n(7).url, { body: 'testo', attachments: [{ name: 'a.pdf', url: 'https://x.unicz.it/a.pdf' }] }); // detail fetched
  assert.equal(db.pendingDeliveries(d).length, 1); // released
  assert.equal(db.getNotice(d, n(7).url).attachments[0].name, 'a.pdf'); // JSON decoded
});

// Key/value helpers round-trip strings.
// !prova queues the newest (seeded) notice of each mapped course once, and waits for its body like normal notices.
test('queueLatestNoticePerGroup sends the newest notice once per group', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.upsertNotices(d, 'infermieristica', [n(1, { body: 'a' }), n(2, { published: '2026-10-09T10:00:00.000Z' })], false); // seeded history
  db.linkGroup(d, 'infermieristica', 'g@g.us'); // mapped after the seed
  assert.equal(db.pendingDeliveries(d).length, 0); // nothing by itself
  assert.equal(db.queueLatestNoticePerGroup(d), 1); // newest one queued
  assert.equal(db.queueLatestNoticePerGroup(d), 0); // not twice
  assert.deepEqual(
    db.noticesNeedingDetail(d, 10).map((r) => r.url),
    [n(2).url],
  ); // its body is fetched even though it was seeded
  assert.equal(db.pendingDeliveries(d).length, 0); // held back until the body arrives
  db.saveDetail(d, n(2).url, { body: 'b', attachments: [] }); // detail fetched
  assert.deepEqual(
    db.pendingDeliveries(d).map((r) => r.url),
    [n(2).url],
  ); // released
  db.recordDelivery(d, n(2).url, 'g@g.us', 'sent'); // sent
  assert.equal(db.queueLatestNoticePerGroup(d), 0); // already delivered: not queued again
  assert.equal(db.queueLatestNoticePerGroup(d, 'fisioterapia'), 0); // unmapped target
});

// !svuota drops the whole queue, also messages still waiting for their body.
test('cancelPendingDeliveries empties the queue', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.linkGroup(d, 'infermieristica', 'g@g.us'); // mapping first
  db.upsertNotices(d, 'infermieristica', [n(1, { body: 'a' }), n(2)], true); // one ready, one waiting for its body
  assert.equal(db.pendingDeliveries(d).length, 1); // only the ready one is visible to the sender
  assert.equal(db.cancelPendingDeliveries(d), 2); // both dropped
  db.saveDetail(d, n(2).url, { body: 'b', attachments: [] }); // body arrives later
  assert.equal(db.pendingDeliveries(d).length, 0); // still dropped
  assert.equal(db.countSentLastHour(d) + db.countFailedLastDay(d), 0); // not counted as sent or failed
});

// Same title and attachments under another URL = duplicate; another attachment number = a different notice.
test('wasIdenticalNoticeSent', () => {
  const d = db.openDb(':memory:'); // fresh DB
  const pdf = (id) => [{ name: 'x.pdf', url: `https://medicina.unicz.it/scarica_allegato/${id}` }]; // attachment link
  db.upsertNotices(
    d,
    'infermieristica',
    [
      n(1, { title: 'Lezione  SPOSTATA', attachments: pdf(5) }),
      n(2, { title: 'lezione spostata', attachments: pdf(5) }),
      n(3, { title: 'Lezione spostata', attachments: pdf(6) }),
    ],
    true,
  ); // same title
  assert.equal(db.wasIdenticalNoticeSent(d, n(2).url, 'g@g.us'), false); // nothing sent yet
  db.recordDelivery(d, n(1).url, 'g@g.us', 'sent'); // first one sent
  assert.equal(db.wasIdenticalNoticeSent(d, n(2).url, 'g@g.us'), true); // same title and attachment: duplicate
  assert.equal(db.wasIdenticalNoticeSent(d, n(3).url, 'g@g.us'), false); // other attachment number: new notice
  assert.equal(db.wasIdenticalNoticeSent(d, n(2).url, 'other@g.us'), false); // other group never got it
});

// DB with one notice already sent to g@g.us and one candidate; returns the answer for the candidate.
const sameTextAfter = (sent, candidate, { status = 'sent', jid = 'g@g.us' } = {}) => {
  const d = db.openDb(':memory:'); // fresh DB
  db.upsertNotices(d, 'infermieristica', [n(1, { title: 'Titolo', body: 'Testo', ...sent }), n(2, { title: 'Titolo', body: 'Testo', ...candidate })], true); // sent notice first
  db.recordDelivery(d, n(1).url, 'g@g.us', status); // the earlier delivery
  return db.wasSameTextSent(d, n(2).url, jid); // answer for the candidate
};

// Same words under another URL = an update of what the group already read.
test('wasSameTextSent: same title and body', () => {
  assert.equal(sameTextAfter({}, {}), true); // identical
  assert.equal(sameTextAfter({}, { attachments: [{ name: 'x.pdf', url: 'https://medicina.unicz.it/scarica_allegato/9' }] }), true); // new files, same text
  assert.equal(sameTextAfter({ body: 'Riga uno\n\n  Riga due' }, { body: 'Riga uno Riga due' }), true); // spaces and line breaks are not words
  assert.equal(sameTextAfter({ body: null }, { body: '' }), true); // a missing body and an empty one read the same
});

// The real case (Fondazione, 2026-11): the sites paste the attachment link inside the text, and sometimes lose a space after it.
test('wasSameTextSent: links inside the text are ignored', () => {
  const link = (id) => `https://www.fondazioneumg.it/servizi/gestionedocumentale/visualizzadocumento.aspx?ID=${id}`; // attachment link
  const first = { body: `Scarica (${link(5508)}) l'avviso e la domanda` }; // with the space
  assert.equal(sameTextAfter(first, { body: `Scarica (${link(5511)}) l'avviso e la domanda` }), true); // only the link number changes
  assert.equal(sameTextAfter(first, { body: `Scarica (${link(5511)})l'avviso e la domanda` }), true); // the space after the link is lost too
  assert.equal(sameTextAfter(first, { body: `Scarica (${link(5511)})l'avviso e la nuova domanda` }), false); // one word added after the link
});

// Anything the reader would see as different keeps the normal message.
test('wasSameTextSent: different words are a different notice', () => {
  assert.equal(sameTextAfter({}, { body: 'Testo diverso' }), false); // other body
  assert.equal(sameTextAfter({}, { title: 'Altro titolo' }), false); // other title
  assert.equal(sameTextAfter({ body: 'Lezione in aula 5' }, { body: 'Lezione in aula 6' }), false); // numbers outside links count
  assert.equal(sameTextAfter({ body: 'Lezione sospesa' }, { body: 'Lezione Sospesa' }), false); // upper case is not 100% the same
  assert.equal(sameTextAfter({ body: 'Lezione sospesa' }, { body: 'Lezione sospesa.' }), false); // neither is punctuation
  assert.equal(sameTextAfter({ title: 'Titolo', body: 'Testo' }, { title: 'TitoloTesto', body: '' }), false); // title and body are compared separately
});

// Only a message the group really received can be updated.
test('wasSameTextSent: only sent messages of this group count', () => {
  assert.equal(sameTextAfter({}, {}, { jid: 'other@g.us' }), false); // another group never read it
  for (const status of ['failed', 'skipped', 'duplicate']) assert.equal(sameTextAfter({}, {}, { status }), false); // never reached the group as this notice
  const d = db.openDb(':memory:'); // fresh DB
  db.upsertNotices(d, 'infermieristica', [n(1, { title: 'Titolo', body: 'Testo' })], true); // one notice
  assert.equal(db.wasSameTextSent(d, n(1).url, 'g@g.us'), false); // nothing sent at all
  db.recordDelivery(d, n(1).url, 'g@g.us', 'sent'); // sent
  assert.equal(db.wasSameTextSent(d, n(1).url, 'g@g.us'), false); // a notice is not an update of itself
});

// No time limit, but an older notice sent late (retry, !prova) is not an update of a newer one.
test('wasSameTextSent: time', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.upsertNotices(d, 'infermieristica', [n(1, { title: 'Titolo', body: 'Testo' }), n(2, { title: 'Titolo', body: 'Testo' })], true); // twins
  d.prepare('UPDATE notices SET first_seen = ? WHERE url = ?').run('2025-01-01T00:00:00.000Z', n(1).url); // the first is much older
  db.recordDelivery(d, n(1).url, 'g@g.us', 'sent'); // sent back then
  d.prepare('UPDATE deliveries SET at = ? WHERE url = ?').run('2025-01-01T00:01:00.000Z', n(1).url); // long before the 3-day duplicate window
  assert.equal(db.wasSameTextSent(d, n(2).url, 'g@g.us'), true); // still the same text
  db.recordDelivery(d, n(2).url, 'late@g.us', 'sent'); // the newer one reached this group first
  assert.equal(db.wasSameTextSent(d, n(1).url, 'late@g.us'), false); // the older one is not its update
});

// DB with one old notice linked to g@g.us, ready for page updates.
const updateSetup = () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.linkGroup(d, 'infermieristica', 'g@g.us'); // group first
  db.upsertNotices(d, 'infermieristica', [n(1, { body: 'Testo' })], false); // an old seeded page
  d.prepare("UPDATE notices SET first_seen = '2026-01-01T00:00:00.000Z'").run(); // long before today
  return d; // ready
};
const hoursAgo = (hours) => new Date(Date.now() - hours * 36e5).toISOString(); // past timestamp
const pastUpdate = (d, hours) => d.prepare('INSERT INTO notice_updates (url, target, at) VALUES (?, ?, ?)').run(n(1).url, 'infermieristica', hoursAgo(hours)); // an earlier update

// At most two updates per page in any 24 hours, and never two within an hour.
test('recordNoticeUpdate: daily cap and quiet time', () => {
  const first = updateSetup(); // no update yet
  assert.equal(db.recordNoticeUpdate(first, n(1).url, ['infermieristica']), true); // the first goes
  assert.equal(db.recordNoticeUpdate(first, n(1).url, ['infermieristica']), false); // a second save right after does not
  const afterOne = updateSetup(); // one update 2 hours ago
  pastUpdate(afterOne, 2);
  assert.equal(db.recordNoticeUpdate(afterOne, n(1).url, ['infermieristica']), true); // the second of the day goes
  const afterTwo = updateSetup(); // two updates today
  pastUpdate(afterTwo, 10);
  pastUpdate(afterTwo, 2);
  assert.equal(db.recordNoticeUpdate(afterTwo, n(1).url, ['infermieristica']), false); // the third does not
  const nextDay = updateSetup(); // two updates, one out of the window
  pastUpdate(nextDay, 25);
  pastUpdate(nextDay, 2);
  assert.equal(db.recordNoticeUpdate(nextDay, n(1).url, ['infermieristica']), true); // the window is rolling
});

// One update for two boards is one update: it must not eat the daily cap.
test('recordNoticeUpdate: an update on two boards counts once', () => {
  const d = updateSetup(); // one old page
  const twoHoursAgo = hoursAgo(2); // same time for both rows
  for (const target of ['infermieristica', 'medicina'])
    d.prepare('INSERT INTO notice_updates (url, target, at) VALUES (?, ?, ?)').run(n(1).url, target, twoHoursAgo); // one update
  assert.equal(db.recordNoticeUpdate(d, n(1).url, ['infermieristica']), true); // the second of the day still goes
});

// A twin sent more than 3 days ago is not a duplicate any more: the same notice may be published again.
test('wasIdenticalNoticeSent: only the last 3 days count', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.upsertNotices(d, 'infermieristica', [n(1, { title: 'Lezione spostata' }), n(2, { title: 'Lezione spostata' })], true); // twins
  db.recordDelivery(d, n(1).url, 'g@g.us', 'sent'); // sent
  assert.equal(db.wasIdenticalNoticeSent(d, n(2).url, 'g@g.us'), true); // just now: duplicate
  d.prepare('UPDATE deliveries SET at = ?').run(hoursAgo(4 * 24)); // 4 days ago
  assert.equal(db.wasIdenticalNoticeSent(d, n(2).url, 'g@g.us'), false); // out of the window
});

// The cap counts per page: a busy page does not silence the others.
test('recordNoticeUpdate: the cap is per page, and a just published page is silent', () => {
  const d = updateSetup(); // one old page
  db.upsertNotices(d, 'infermieristica', [n(2, { body: 'Altro' })], false); // another page, just seen
  assert.equal(db.recordNoticeUpdate(d, n(2).url, ['infermieristica']), false); // a fix right after publishing
  d.prepare("UPDATE notices SET first_seen = '2026-01-01T00:00:00.000Z'").run(); // both old now
  assert.equal(db.recordNoticeUpdate(d, n(1).url, ['infermieristica']), true); // page 1
  assert.equal(db.recordNoticeUpdate(d, n(2).url, ['infermieristica']), true); // page 2 is not affected
});

// An update reaches every group of the page once, without touching the record of the first send.
test('pendingDeliveries lists page updates', () => {
  const d = updateSetup(); // old page, one group
  db.linkGroup(d, 'infermieristica', 'b@g.us'); // a second group
  db.recordDelivery(d, n(1).url, 'g@g.us', 'sent'); // the first message went long ago
  assert.equal(db.pendingDeliveries(d).length, 0); // nothing to do
  db.recordNoticeUpdate(d, n(1).url, ['infermieristica']); // the page changes
  const queued = db.pendingDeliveries(d); // one row per group
  assert.equal(queued.length, 2); // both groups
  assert.ok(queued.every((row) => row.isUpdate === 1 && row.url === n(1).url && row.deliveryKey.startsWith(`${n(1).url}#aggiornamento-`))); // their own key
  db.recordDelivery(d, queued[0].deliveryKey, queued[0].jid, 'sent'); // one group served
  assert.equal(db.pendingDeliveries(d).length, 1); // the other is left
  assert.equal(db.countSentLastHour(d), 2); // the update counts for the hourly cap
  assert.equal(d.prepare('SELECT COUNT(*) AS total FROM deliveries WHERE url = ?').get(n(1).url).total, 1); // the first send is untouched
  assert.equal(db.cancelPendingDeliveries(d), 1); // !svuota removes it
  assert.equal(db.pendingDeliveries(d).length, 0); // gone for good
});

// The update goes to the boards named, not to every target the page ever had; a group with two of them gets one message.
test('pendingDeliveries: page updates reach only the boards named', () => {
  const d = updateSetup(); // old page of infermieristica
  db.upsertNotices(d, ['medicina', 'fisioterapia'], [n(1)], false); // the old school fan-out left more targets
  for (const target of ['medicina', 'fisioterapia']) db.linkGroup(d, target, `${target}@g.us`); // their groups
  db.linkGroup(d, 'medicina', 'g@g.us'); // this group has two of the boards named
  db.recordNoticeUpdate(d, n(1).url, ['medicina', 'infermieristica']); // listed there today
  assert.deepEqual(
    db
      .pendingDeliveries(d)
      .map((row) => row.jid)
      .sort(),
    ['g@g.us', 'medicina@g.us'],
  ); // no fisioterapia, and g@g.us once
});

// No floods after downtime, nothing for a group linked after the update.
test('pendingDeliveries: limits of page updates', () => {
  const old = updateSetup(); // old page
  old.prepare("UPDATE group_map SET created_at = '2026-01-01T00:00:00.000Z'").run(); // linked long ago: only the age can stop it
  pastUpdate(old, 4 * 24); // 4 days ago
  assert.equal(db.pendingDeliveries(old).length, 0); // too old
  pastUpdate(old, 2 * 24); // 2 days ago
  assert.equal(db.pendingDeliveries(old).length, 1); // still fresh
  const relinked = updateSetup(); // old page
  pastUpdate(relinked, 1); // one hour ago
  relinked.prepare("UPDATE group_map SET created_at = '2099-01-01T00:00:00.000Z'").run(); // linked after that
  assert.equal(db.pendingDeliveries(relinked).length, 0); // not retroactive
  const unlinked = updateSetup(); // old page
  db.unlinkGroup(unlinked, 'infermieristica', 'g@g.us'); // no group
  db.recordNoticeUpdate(unlinked, n(1).url, ['infermieristica']); // the page changes
  assert.equal(db.pendingDeliveries(unlinked).length, 0); // nobody to tell
});

test('kv round trip', () => {
  const d = db.openDb(':memory:'); // fresh DB
  assert.equal(db.getStateValue(d, 'x'), null); // missing key
  db.setStateValue(d, 'x', 1); // write
  db.setStateValue(d, 'x', 2); // overwrite
  assert.equal(db.getStateValue(d, 'x'), '2'); // stored as string
});

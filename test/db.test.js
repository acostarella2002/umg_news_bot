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
  db.mapGroup(d, 'infermieristica', '123@g.us'); // group mapped after the seed
  db.upsertNotices(d, 'infermieristica', [n(2, { body: 'y' })], true); // genuinely new notice
  const p = db.pendingDeliveries(d); // what should be sent
  assert.deepEqual(
    p.map((r) => r.url),
    [n(2).url],
  ); // only the new one
  db.recordDelivery(d, n(2).url, '123@g.us', 'sent'); // mark as sent
  assert.equal(db.pendingDeliveries(d).length, 0); // nothing left
  assert.equal(db.sentLastHour(d), 1); // rate counter sees it
});

// A notice linked to two targets mapped to the same group is sent once to that group.
test('pendingDeliveries sends once per group', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.mapGroup(d, 'medicina', 'g1@g.us'); // school target
  db.mapGroup(d, 'infermieristica', 'g1@g.us'); // course target, same group
  db.upsertNotices(d, 'medicina', [n(5, { body: '' })], true); // school notice
  db.upsertNotices(d, 'infermieristica', [n(5, { body: '' })], true); // also listed on the course
  assert.equal(db.pendingDeliveries(d).length, 1); // one message only
});

// Notices without body wait for the detail page (but not forever).
test('pendingDeliveries waits for detail body', () => {
  const d = db.openDb(':memory:'); // fresh DB
  db.mapGroup(d, 'infermieristica', 'g@g.us'); // mapping first
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
test('kv round trip', () => {
  const d = db.openDb(':memory:'); // fresh DB
  assert.equal(db.getKv(d, 'x'), null); // missing key
  db.setKv(d, 'x', 1); // write
  db.setKv(d, 'x', 2); // overwrite
  assert.equal(db.getKv(d, 'x'), '2'); // stored as string
});

// Unit tests for src/whatsapp/keepalive.js.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, setStateValue } from '../src/db.js'; // storage
import { sendKeepaliveIfDue } from '../src/whatsapp/keepalive.js'; // module under test

// Sends once, then waits for `days` before sending again; never sends while offline.
test('sendKeepaliveIfDue schedule', async () => {
  const db = openDb(':memory:'); // fresh DB
  const sent = []; // recorded messages
  const sock = { user: { id: '393330000000:7@s.whatsapp.net' }, sendMessage: async (jid, m) => void sent.push([jid, m.text]) }; // fake socket
  const t0 = Date.parse('2026-10-09T10:00:00Z'); // fixed clock
  assert.equal(await sendKeepaliveIfDue({ db, sock: null, intervalDays: 7, now: t0 }), false); // offline: nothing
  assert.equal(await sendKeepaliveIfDue({ db, sock, intervalDays: 7, now: t0 }), true); // first reminder
  assert.equal(await sendKeepaliveIfDue({ db, sock, intervalDays: 7, now: t0 + 6 * 864e5 }), false); // 6 days later: not due
  assert.equal(await sendKeepaliveIfDue({ db, sock, intervalDays: 7, now: t0 + 7 * 864e5 }), true); // 7 days later: due
  assert.equal(sent.length, 2); // exactly two messages
  assert.ok(sent.every(([jid]) => jid === '393330000000@s.whatsapp.net')); // only to the self chat
  assert.match(sent[0][1], /telefono principale/); // reminder text
  setStateValue(db, 'last_poll', '2026-11-04T17:40:00.000Z'); // UTC in the DB
  await sendKeepaliveIfDue({ db, sock, intervalDays: 7, now: t0 + 14 * 864e5 }); // next reminder
  assert.match(sent[2][1], /Ultimo controllo bacheche: 04\/11\/2026, 18:40/); // Italian time
});

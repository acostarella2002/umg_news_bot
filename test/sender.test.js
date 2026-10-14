// Unit tests for src/whatsapp/sender.js with a fake WhatsApp socket.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, upsertNotices, mapGroup, setKv, pendingDeliveries } from '../src/db.js'; // storage
import { createSender } from '../src/whatsapp/sender.js'; // module under test

const cfg = { sendMinDelayS: 8, sendMaxDelayS: 20, slowMinDelayS: 120, slowMaxDelayS: 180, maxSendsPerHour: 2 }; // tiny hourly cap for the test

// Fake socket recording calls; `fail` makes sendMessage throw.
const fakeSock = (fail = false) => {
  const calls = []; // recorded calls
  return {
    calls, // exposed for assertions
    sendPresenceUpdate: async (s, jid) => void calls.push(['presence', s, jid]), // record presence
    sendMessage: async (jid, m) => {
      if (fail) throw new Error('boom'); // simulated WhatsApp error
      calls.push(['msg', jid, m.text]); // record the sent text
    }, // record or fail
  };
};

// DB with one mapped group and `count` fresh notices.
const setup = (count, jid = 'g@g.us') => {
  const db = openDb(':memory:'); // fresh DB
  mapGroup(db, 'giuri', jid); // mapping first
  upsertNotices(
    db,
    'giuri',
    Array.from({ length: count }, (_, i) => ({ url: `https://diges.unicz.it/avviso/${i}`, title: `T${i}`, body: 'b' })),
    true,
  ); // new notices
  return db; // ready
};

// Sends one message with typing presence and respects the hourly cap.
test('sends with presence and honours rate limit', async () => {
  const db = setup(3); // three pending
  const sock = fakeSock(); // working socket
  const s = createSender({ db, getSock: () => sock, names: new Map([['giuri', 'Giurisprudenza']]), cfg, sleep: async () => {} }); // no real waiting
  assert.equal(await s.sendNext(), 'sent'); // 1st
  assert.equal(await s.sendNext(), 'sent'); // 2nd
  assert.equal(await s.sendNext(), 'rate'); // cap of 2/hour reached
  assert.deepEqual(sock.calls[0], ['presence', 'composing', 'g@g.us']); // typed first
  assert.match(sock.calls[1][2], /T0[\s\S]*https:\/\/diges\.unicz\.it\/avviso\/0/); // formatted notice sent
});

// Pause flag and missing connection stop sending.
test('paused and offline', async () => {
  const db = setup(1); // one pending
  const s = createSender({ db, getSock: () => null, names: new Map(), cfg, sleep: async () => {} }); // offline
  assert.equal(await s.sendNext(), 'offline'); // no socket
  setKv(db, 'paused', '1'); // owner paused
  assert.equal(await s.sendNext(), 'paused'); // paused wins
});

// A failed message waits in the retry lane (5 then 15 minutes) and is given up after the third failure.
test('retries in background and gives up after three failures', async () => {
  const db = setup(1); // one pending
  let now = 0; // fake clock
  const s = createSender({ db, getSock: () => fakeSock(true), names: new Map(), cfg, sleep: async () => {}, clock: () => now }); // always failing
  assert.equal(await s.sendNext(), 'error'); // 1st attempt
  assert.equal(await s.sendNext(), 'waiting'); // cooling down, nothing else to send
  now += 5 * 60_000; // 5 minutes later
  assert.equal(await s.sendNext(), 'error'); // 2nd attempt
  now += 5 * 60_000; // only 10 minutes after the first retry
  assert.equal(await s.sendNext(), 'waiting'); // second pause is 15 minutes
  now += 10 * 60_000; // 15 minutes reached
  assert.equal(await s.sendNext(), 'error'); // 3rd attempt
  assert.equal(pendingDeliveries(db).length, 0); // given up, removed from the queue
});

// A broken group no longer blocks the queue: the other groups are served while it waits.
test('a failing group does not block the others', async () => {
  const db = openDb(':memory:'); // fresh DB
  mapGroup(db, 'giuri', 'bad@g.us'); // e.g. bot not admin there
  mapGroup(db, 'giuri', 'ok@g.us'); // healthy group
  upsertNotices(db, 'giuri', [{ url: 'https://diges.unicz.it/avviso/1', title: 'T', body: 'b' }], true); // one notice for both
  const calls = []; // delivered messages
  const sock = {
    sendPresenceUpdate: async () => {}, // typing indicator
    sendMessage: async (jid) => {
      if (jid === 'bad@g.us') throw new Error('not-authorized'); // broken group
      calls.push(jid); // delivered
    },
  };
  const s = createSender({ db, getSock: () => sock, names: new Map(), cfg: { ...cfg, maxSendsPerHour: 10 }, sleep: async () => {} }); // sender
  const results = [await s.sendNext(), await s.sendNext(), await s.sendNext()]; // both groups tried, then only the retry is left
  assert.deepEqual([...results.slice(0, 2)].sort(), ['error', 'sent']); // one failed, one delivered, in either order
  assert.equal(results[2], 'waiting'); // the failed one waits aside
  assert.deepEqual(calls, ['ok@g.us']); // the healthy group got its message
});

// Long queue (many notices at once) -> one message every 2-3 minutes; short queue -> normal 8-20 s.
test('slows down on a long queue', async () => {
  // Run the loop until its first pause after a send and return that pause.
  const firstGap = async (count) => {
    const db = setup(count); // `count` pending
    const stop = new AbortController(); // ends the endless loop
    let gap; // measured pause
    const sleep = async (ms) => {
      if (ms === 1500) return; // typing time (rand = 0)
      gap = ms; // the pause between messages
      stop.abort(); // one step is enough
    };
    const s = createSender({ db, getSock: () => fakeSock(), names: new Map(), cfg: { ...cfg, maxSendsPerHour: 100 }, sleep, rand: () => 0 }); // lowest bound
    await s.run(stop.signal); // one iteration
    return gap;
  };
  assert.equal(await firstGap(12), 120_000); // 11 still queued -> slow pace
  assert.equal(await firstGap(3), 8_000); // short queue -> normal pace
});

// A non-group JID (a person) is never messaged.
test('refuses to message individuals', async () => {
  const db = setup(1, '393331234567@s.whatsapp.net'); // mapping to a person (should never happen)
  const sock = fakeSock(); // working socket
  const s = createSender({ db, getSock: () => sock, names: new Map(), cfg, sleep: async () => {} }); // sender
  assert.equal(await s.sendNext(), 'failed'); // refused
  assert.equal(sock.calls.length, 0); // nothing sent at all
});

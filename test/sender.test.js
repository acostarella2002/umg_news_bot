// Unit tests for src/whatsapp/sender.js with a fake WhatsApp socket.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, upsertNotices, linkGroup, setStateValue, pendingDeliveries, countSentLastHour, recordDelivery } from '../src/db.js'; // storage
import { createSender } from '../src/whatsapp/sender.js'; // module under test
import { formatNotice } from '../src/whatsapp/format.js'; // the message as it is normally built

const senderConfig = { sendMinDelayS: 8, sendMaxDelayS: 20, slowMinDelayS: 120, slowMaxDelayS: 180, maxSendsPerHour: 2 }; // tiny hourly cap for the test

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
  linkGroup(db, 'giuri', jid); // mapping first
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
  const s = createSender({ db, getSocket: () => sock, targetNames: new Map([['giuri', 'Giurisprudenza']]), config: senderConfig, sleep: async () => {} }); // no real waiting
  assert.equal(await s.sendNextMessage(), 'sent'); // 1st
  assert.equal(await s.sendNextMessage(), 'sent'); // 2nd
  assert.equal(await s.sendNextMessage(), 'rate'); // cap of 2/hour reached
  assert.deepEqual(sock.calls[0], ['presence', 'composing', 'g@g.us']); // typed first
  assert.match(sock.calls[1][2], /T0[\s\S]*https:\/\/diges\.unicz\.it\/avviso\/0/); // formatted notice sent
});

// Pause flag and missing connection stop sending.
test('paused and offline', async () => {
  const db = setup(1); // one pending
  const s = createSender({ db, getSocket: () => null, targetNames: new Map(), config: senderConfig, sleep: async () => {} }); // offline
  assert.equal(await s.sendNextMessage(), 'offline'); // no socket
  setStateValue(db, 'paused', '1'); // owner paused
  assert.equal(await s.sendNextMessage(), 'paused'); // paused wins
});

// A failed message waits in the retry lane (5 then 15 minutes) and is given up after the third failure.
test('retries in background and gives up after three failures', async () => {
  const db = setup(1); // one pending
  let now = 0; // fake clock
  const s = createSender({ db, getSocket: () => fakeSock(true), targetNames: new Map(), config: senderConfig, sleep: async () => {}, clock: () => now }); // always failing
  assert.equal(await s.sendNextMessage(), 'error'); // 1st attempt
  assert.equal(await s.sendNextMessage(), 'waiting'); // cooling down, nothing else to send
  now += 5 * 60_000; // 5 minutes later
  assert.equal(await s.sendNextMessage(), 'error'); // 2nd attempt
  now += 5 * 60_000; // only 10 minutes after the first retry
  assert.equal(await s.sendNextMessage(), 'waiting'); // second pause is 15 minutes
  now += 10 * 60_000; // 15 minutes reached
  assert.equal(await s.sendNextMessage(), 'error'); // 3rd attempt
  assert.equal(pendingDeliveries(db).length, 0); // given up, removed from the queue
});

// A broken group no longer blocks the queue: the other groups are served while it waits.
test('a failing group does not block the others', async () => {
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'giuri', 'bad@g.us'); // e.g. bot not admin there
  linkGroup(db, 'giuri', 'ok@g.us'); // healthy group
  upsertNotices(db, 'giuri', [{ url: 'https://diges.unicz.it/avviso/1', title: 'T', body: 'b' }], true); // one notice for both
  const calls = []; // delivered messages
  const sock = {
    sendPresenceUpdate: async () => {}, // typing indicator
    sendMessage: async (jid) => {
      if (jid === 'bad@g.us') throw new Error('not-authorized'); // broken group
      calls.push(jid); // delivered
    },
  };
  const s = createSender({ db, getSocket: () => sock, targetNames: new Map(), config: { ...senderConfig, maxSendsPerHour: 10 }, sleep: async () => {} }); // sender
  const results = [await s.sendNextMessage(), await s.sendNextMessage(), await s.sendNextMessage()]; // both groups tried, then only the retry is left
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
    const s = createSender({
      db,
      getSocket: () => fakeSock(),
      targetNames: new Map(),
      config: { ...senderConfig, maxSendsPerHour: 100 },
      sleep,
      random: () => 0,
    }); // lowest bound
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
  const s = createSender({ db, getSocket: () => sock, targetNames: new Map(), config: senderConfig, sleep: async () => {} }); // sender
  assert.equal(await s.sendNextMessage(), 'failed'); // refused
  assert.equal(sock.calls.length, 0); // nothing sent at all
});

// The same notice published twice (other URL, same title and attachments) reaches a group only once.
test('skips duplicates without waiting', async () => {
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'giuri', 'g@g.us'); // mapping first
  upsertNotices(
    db,
    'giuri',
    ['1', '2'].map((i) => ({ url: `https://diges.unicz.it/avviso/${i}`, title: 'Lezione spostata', body: 'b' })),
    true,
  ); // twins
  const sock = fakeSock(); // working socket
  const s = createSender({ db, getSocket: () => sock, targetNames: new Map(), config: senderConfig, sleep: async () => {} }); // no real waiting
  assert.equal(await s.sendNextMessage(), 'sent'); // first copy
  assert.equal(await s.sendNextMessage(), 'duplicate'); // second copy dropped
  assert.equal(await s.sendNextMessage(), 'idle'); // queue empty
  assert.equal(sock.calls.filter((c) => c[0] === 'msg').length, 1); // one message only
});

// Twin notice: same text under its own URL, with its own attachment (`file`), like a republication with new files.
const twinNotice = (id, file = id) => ({
  url: `https://diges.unicz.it/avviso/${id}`,
  title: 'Posti letto',
  body: 'Scarica il bando',
  attachments: [{ name: 'bando.pdf', url: `https://diges.unicz.it/scarica_allegato/${file}` }],
});
// Sender on a fresh DB where the twins are queued for the given groups.
const setupTwins = (twins, jids = ['g@g.us'], senderOptions = {}) => {
  const db = openDb(':memory:'); // fresh DB
  for (const jid of jids) linkGroup(db, 'giuri', jid); // mapping first
  upsertNotices(db, 'giuri', twins, true); // queued oldest first
  const sock = fakeSock(); // working socket
  const sender = createSender({
    db,
    getSocket: () => sock,
    targetNames: new Map(),
    config: { ...senderConfig, maxSendsPerHour: 100 },
    sleep: async () => {},
    ...senderOptions,
  });
  return { db, sock, sender }; // ready
};
const sentTexts = (sock) => sock.calls.filter((call) => call[0] === 'msg').map((call) => call[2]); // texts really sent

// A republication with new files: the label, then the message exactly as it is normally built.
test('same text with new files is sent as an update', async () => {
  const { sock, sender } = setupTwins([twinNotice(1), twinNotice(2)]); // two twins
  assert.equal(await sender.sendNextMessage(), 'sent'); // the original
  assert.equal(await sender.sendNextMessage(), 'sent'); // the republication is not dropped
  assert.equal(await sender.sendNextMessage(), 'idle'); // nothing else
  const [first, second] = sentTexts(sock); // both messages
  assert.equal(first, formatNotice(twinNotice(1), 'giuri')); // no label on the original
  assert.equal(second, `Aggiornamento in:\n\n${formatNotice(twinNotice(2), 'giuri')}`); // label plus the unchanged message, with its own link
});

// Every later copy says it once: labels never pile up.
test('a third copy has one label only', async () => {
  const { sock, sender } = setupTwins([twinNotice(1), twinNotice(2), twinNotice(3)]); // three twins
  for (let step = 0; step < 3; step++) assert.equal(await sender.sendNextMessage(), 'sent'); // all sent
  const labels = sentTexts(sock).map((text) => text.match(/Aggiornamento in:/g)?.length ?? 0); // labels per message
  assert.deepEqual(labels, [0, 1, 1]); // never two
});

// Same title and same files within 3 days stay a pure duplicate: nothing new for the group.
test('a duplicate is still dropped, not sent as an update', async () => {
  const { sock, sender } = setupTwins([twinNotice(1, 'same'), twinNotice(2, 'same')]); // same attachment
  assert.equal(await sender.sendNextMessage(), 'sent'); // the original
  assert.equal(await sender.sendNextMessage(), 'duplicate'); // dropped
  assert.equal(sentTexts(sock).length, 1); // one message only
});

// Each group is judged on what it received: the first copy for a group has no label.
test('the label depends on the group', async () => {
  const { db, sock, sender } = setupTwins([twinNotice(2)], ['a@g.us', 'b@g.us']); // one notice for two groups
  recordDelivery(db, twinNotice(2).url, 'b@g.us', 'skipped'); // not for this group
  upsertNotices(db, 'giuri', [twinNotice(1)], false); // the old twin was only seeded: never sent to anyone
  assert.equal(await sender.sendNextMessage(), 'sent'); // group a
  assert.equal(await sender.sendNextMessage(), 'idle'); // nothing else
  assert.deepEqual(
    sock.calls.filter((call) => call[0] === 'msg').map((call) => [call[1], call[2].includes('Aggiornamento in:')]),
    [['a@g.us', false]],
  ); // a seeded twin does not count
  upsertNotices(db, 'giuri', [twinNotice(3)], true); // a real republication
  assert.equal(await sender.sendNextMessage(), 'sent'); // group a got the original, so this is an update
  assert.equal(await sender.sendNextMessage(), 'sent'); // group b never got it: a normal message
  assert.deepEqual(
    sock.calls
      .filter((call) => call[0] === 'msg')
      .slice(1)
      .map((call) => [call[1], call[2].includes('Aggiornamento in:')])
      .sort(),
    [
      ['a@g.us', true],
      ['b@g.us', false],
    ],
  ); // one each
});

// A retry rebuilds the same message: the label survives a failed attempt, and the attempt counts only once.
test('an update keeps its label after a failed attempt', async () => {
  let now = 0; // fake clock
  const { sock, sender } = setupTwins([twinNotice(1), twinNotice(2)], ['g@g.us'], { clock: () => now }); // two twins
  assert.equal(await sender.sendNextMessage(), 'sent'); // the original
  const realSend = sock.sendMessage; // working send
  sock.sendMessage = async () => {
    throw new Error('boom');
  }; // WhatsApp fails once
  assert.equal(await sender.sendNextMessage(), 'error'); // first attempt of the update
  sock.sendMessage = realSend; // WhatsApp is back
  now += 5 * 60_000; // retry time
  assert.equal(await sender.sendNextMessage(), 'sent'); // second attempt
  assert.deepEqual(
    sentTexts(sock).map((text) => text.startsWith('Aggiornamento in:\n\n')),
    [false, true],
  ); // labelled, sent once
});

// An update is a normal message for the anti-ban rules: it counts for the hourly cap.
test('an update counts for the hourly cap', async () => {
  const { db, sender } = setupTwins([twinNotice(1), twinNotice(2), twinNotice(3)], ['g@g.us'], { config: senderConfig }); // cap of 2
  assert.equal(await sender.sendNextMessage(), 'sent'); // the original
  assert.equal(await sender.sendNextMessage(), 'sent'); // an update
  assert.equal(countSentLastHour(db), 2); // both counted
  assert.equal(await sender.sendNextMessage(), 'rate'); // cap reached
});

// Real failure instead of a mock: every write to the deliveries table fails, as on a full disk.
const fillDisk = (db) => db.exec("CREATE TRIGGER disk_full BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"); // writes fail
const freeDisk = (db) => db.exec('DROP TRIGGER disk_full'); // writes work again
const countMessages = (sock) => sock.calls.filter((call) => call[0] === 'msg').length; // messages really sent

// A message delivered while the disk is full is never sent again, counts for the hourly cap, and is saved when space comes back.
test('full disk: sent messages are not repeated', async () => {
  const db = setup(3); // three pending
  const sock = fakeSock(); // working socket
  const s = createSender({ db, getSocket: () => sock, targetNames: new Map(), config: senderConfig, sleep: async () => {} }); // hourly cap of 2
  fillDisk(db); // from now on nothing can be written
  assert.equal(await s.sendNextMessage(), 'sent'); // 1st message delivered
  assert.equal(await s.sendNextMessage(), 'sent'); // the 2nd notice, not the 1st again
  assert.equal(await s.sendNextMessage(), 'rate'); // cap reached although the DB counts nothing
  assert.equal(countSentLastHour(db), 0); // the DB really saw nothing
  assert.equal(countMessages(sock), 2); // no repeats
  freeDisk(db); // space is back
  assert.equal(await s.sendNextMessage(), 'rate'); // the two rows are saved, the cap still holds
  assert.equal(countSentLastHour(db), 2); // written
  assert.equal(pendingDeliveries(db).length, 1); // only the third notice is left
  assert.equal(countMessages(sock), 2); // still no repeats
});

// Memory stays bounded: beyond the limit the oldest remembered message is forgotten first.
test('full disk: the oldest remembered message is washed out', async () => {
  const db = setup(3); // three pending
  const sock = fakeSock(); // working socket
  const s = createSender({
    db,
    getSocket: () => sock,
    targetNames: new Map(),
    config: { ...senderConfig, maxSendsPerHour: 100 },
    sleep: async () => {},
    maxUnsavedSends: 2,
  });
  fillDisk(db); // nothing can be written
  for (let step = 0; step < 3; step++) assert.equal(await s.sendNextMessage(), 'sent'); // the third send pushes out the first
  freeDisk(db); // space is back
  assert.equal(await s.sendNextMessage(), 'sent'); // the washed-out notice looks unsent: this is the price of the limit
  assert.equal(countMessages(sock), 4); // exactly that one repeat
  assert.equal(pendingDeliveries(db).length, 0); // queue clean
});

// The "stopped typing" signal is only cosmetic: its failure after the send must not repeat the message.
test('a presence failure after the send does not repeat the message', async () => {
  const db = setup(1); // one pending
  const sock = fakeSock(); // working socket
  sock.sendPresenceUpdate = async (presence) => {
    if (presence === 'paused') throw new Error('connection closed'); // the socket dies right after the send
  };
  const s = createSender({ db, getSocket: () => sock, targetNames: new Map(), config: senderConfig, sleep: async () => {} }); // sender
  assert.equal(await s.sendNextMessage(), 'sent'); // it did leave
  assert.equal(await s.sendNextMessage(), 'idle'); // nothing to retry
  assert.equal(countMessages(sock), 1); // one message only
});

// A failing step (here: a duplicate that cannot be recorded on a full disk) must not end the loop.
test('run survives a failing step', async () => {
  const db = openDb(':memory:'); // fresh DB
  linkGroup(db, 'giuri', 'g@g.us'); // mapping first
  upsertNotices(
    db,
    'giuri',
    ['1', '2'].map((id) => ({ url: `https://diges.unicz.it/avviso/${id}`, title: 'Stesso titolo', body: 'b' })),
    true,
  ); // twins
  const sock = fakeSock(); // working socket
  const logged = []; // recorded errors
  const stop = new AbortController(); // ends the endless loop
  let pauses = 0; // loop iterations seen
  const sleep = async (ms) => {
    if (ms === 1500) return; // typing time (random = 0)
    pauses++; // one step done
    if (pauses === 1) db.exec("CREATE TRIGGER disk_full BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"); // disk fills after the first send
    if (pauses === 2) stop.abort(); // the loop got past the failing step
  };
  const s = createSender({
    db,
    getSocket: () => sock,
    targetNames: new Map(),
    config: senderConfig,
    log: { error: (fields) => logged.push(fields.err) },
    sleep,
    random: () => 0,
  });
  await s.run(stop.signal); // must return, not throw
  assert.equal(pauses, 2); // both steps ran
  assert.match(logged[0], /disk is full/); // the failure is visible in the logs
});

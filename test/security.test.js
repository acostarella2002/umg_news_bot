// Security / privacy tests: the bot must never read, store or log data of the people using it.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { readFileSync } from 'node:fs'; // static source checks
import pino from 'pino'; // real logger, captured into memory
import { openDb, upsertNotices } from '../src/db.js'; // storage
import { filterOwnerCommands, handleCommand } from '../src/whatsapp/commands.js'; // command filter + handler
import { createSender } from '../src/whatsapp/sender.js'; // delivery queue

const BOT = { id: '393330000000:5@s.whatsapp.net', lid: '123456:5@lid' }; // the bot account (fake number)
const STUDENT = '393471234567'; // a student's phone number that must never be persisted
const now = 1_800_000_000; // fixed clock (seconds)
// Build a fake incoming message.
const msg = (remoteJid, fromMe, text, ts = now, participant) => ({
  key: { remoteJid, fromMe, participant },
  messageTimestamp: ts,
  message: { conversation: text },
});

// Only fresh messages written by the account in its own chat pass the filter.
test('filterOwnerCommands drops everything that is not the owner self chat', () => {
  const batch = [
    msg(`${STUDENT}@s.whatsapp.net`, false, '!pausa'), // student DM trying a command
    msg('111-1@g.us', false, '!associa 1 giuri', now, `${STUDENT}@s.whatsapp.net`), // student in a group trying a command
    msg('111-1@g.us', true, '!pausa'), // the bot's own group message
    msg(`${STUDENT}@s.whatsapp.net`, true, '!pausa'), // owner chatting with a student from the phone
    msg('393330000000@s.whatsapp.net', true, '!stato', now - 600), // owner command but replayed history (10 min old)
    msg('393330000000@s.whatsapp.net', true, '!stato'), // the only valid one
  ];
  const kept = filterOwnerCommands(batch, BOT, now); // filter
  assert.equal(kept.length, 1); // exactly one
  assert.equal(kept[0].message.conversation, '!stato'); // the owner's fresh command
});

// Full simulated session: nothing about group members or foreign messages ends up in the DB or logs.
test('no personal data is persisted or logged', async () => {
  const db = openDb(':memory:'); // fresh DB
  const lines = []; // captured log output
  const log = pino({ level: 'trace' }, { write: (s) => lines.push(s) }); // most verbose level
  const sock = {
    user: BOT, // the bot account
    groupFetchAllParticipating: async () => ({
      g: { id: '111-1@g.us', subject: 'Giurisprudenza', participants: [{ id: `${STUDENT}@s.whatsapp.net`, notify: 'Mario Rossi' }] }, // members exposed by WhatsApp
    }),
    sendPresenceUpdate: async () => {}, // no-op
    sendMessage: async () => {
      throw new Error(`send to ${'111-1@g.us'} failed`);
    }, // failure path also exercised
  };
  const ctx = { db, sock, targetNames: new Map([['giuri', 'Giurisprudenza']]), session: {} }; // command context
  await handleCommand('!gruppi', ctx); // reads groups (members included in the API response)
  await handleCommand('!associa 1 giuri', ctx); // maps the group
  upsertNotices(db, 'giuri', [{ url: 'https://diges.unicz.it/avviso/1', title: 'Lezione', body: 'x' }], true); // a notice to send
  const sender = createSender({
    db,
    getSocket: () => sock,
    targetNames: ctx.targetNames,
    config: { sendMinDelayS: 1, sendMaxDelayS: 1, maxSendsPerHour: 10 },
    log,
    sleep: async () => {},
  }); // sender
  await sender.sendNextMessage(); // fails and logs
  // Dump every table to text and search for the student's data.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name); // all tables
  const dump = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n'); // full content
  for (const secret of [STUDENT, 'Mario Rossi']) {
    assert.ok(!dump.includes(secret), `DB contains ${secret}`); // not stored
    assert.ok(!lines.join('').includes(secret), `logs contain ${secret}`); // not logged
  }
  assert.ok(!lines.join('').includes('111-1@g.us'), 'logs contain a group JID'); // even group ids stay out of logs
  assert.deepEqual(tables.sort(), ['deliveries', 'group_map', 'kv', 'manual_sends', 'notice_targets', 'notice_updates', 'notices']); // no table for people exists
});

// Static guarantees on the WhatsApp client configuration.
test('client is configured for privacy', () => {
  const src = readFileSync(new URL('../src/whatsapp/client.js', import.meta.url), 'utf8'); // source text
  assert.match(src, /logger: pino\(\{ level: 'silent' \}\)/); // Baileys internals never log contents
  assert.match(src, /syncFullHistory: false/); // no history download
  assert.match(src, /shouldSyncHistoryMessage: \(\) => false/); // no history sync processing
  assert.match(src, /getMessage: async \(\) => undefined/); // no message store
  assert.match(src, /mode: 0o700/); // private session folder
});

// The log scrubber removes every kind of WhatsApp id and phone numbers.
test('redact', async () => {
  const { redact } = await import('../src/redact.js'); // module under test
  assert.equal(redact('to 393471234567@s.whatsapp.net / 1203-63@g.us / 99:1@lid'), 'to [jid] / [jid] / [jid]'); // JIDs
  assert.equal(redact('call +39 347 123 4567'), 'call [number]'); // phone number
  assert.equal(redact('HTTP 404 for https://diges.unicz.it/avviso/12'), 'HTTP 404 for https://diges.unicz.it/avviso/12'); // public URLs untouched
});

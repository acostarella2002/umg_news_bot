// Unit tests for src/whatsapp/commands.js with a fake socket.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, listGroupLinks, getStateValue, setStateValue, upsertNotices, linkGroup } from '../src/db.js'; // storage
import {
  handleCommand,
  isSelfChat,
  extractMessageText,
  normalizeGroupName,
  autoLinkGroups,
  normalizeTargetId,
  withoutDeviceSuffix,
} from '../src/whatsapp/commands.js'; // module under test

const user = { id: '393330000000:5@s.whatsapp.net', lid: '123456:5@lid' }; // the bot account (fake number)
const names = new Map([
  ['giuri', 'Giurisprudenza'],
  ['ateneo', 'Ateneo UMG'],
]); // known targets
// Fake socket returning two groups and one community parent.
const sock = {
  groupFetchAllParticipating: async () => ({
    a: { id: '111-1@g.us', subject: 'Zeta', linkedParent: '999@g.us' }, // group inside the community
    b: { id: '222-2@g.us', subject: 'Alfa', isCommunityAnnounce: true, linkedParent: '999@g.us' }, // community board
    c: { id: '999@g.us', subject: 'UMG automated news', isCommunity: true }, // community parent
  }),
};

// Device suffix is removed from an account JID, in both forms; no JID gives an empty string.
test('withoutDeviceSuffix', () => {
  assert.equal(withoutDeviceSuffix(user.id), '393330000000@s.whatsapp.net'); // phone-number form
  assert.equal(withoutDeviceSuffix(user.lid), '123456@lid'); // LID form
  assert.equal(withoutDeviceSuffix(undefined), ''); // not connected
});

// !stato shows the last poll in Italian time, in winter and in summer; the DB keeps UTC.
test('!stato uses Italian time', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, targetNames: names, session: {} }; // command context
  assert.match(await handleCommand('!stato', ctx), /Ultimo controllo: mai/); // never polled
  setStateValue(db, 'last_poll', '2026-11-04T17:40:00.000Z'); // winter: UTC+1
  assert.match(await handleCommand('!stato', ctx), /Ultimo controllo: 04\/11\/2026, 18:40/); // not 17:40
  setStateValue(db, 'last_poll', '2026-07-01T10:00:00.000Z'); // summer: UTC+2
  assert.match(await handleCommand('!stato', ctx), /Ultimo controllo: 01\/07\/2026, 12:00/); // not 10:00
});

// Only fromMe messages in the self chat count, in both JID forms.
test('isSelfChat', () => {
  assert.ok(isSelfChat({ key: { fromMe: true, remoteJid: '393330000000@s.whatsapp.net' } }, user)); // phone-number form
  assert.ok(isSelfChat({ key: { fromMe: true, remoteJid: '123456@lid' } }, user)); // LID form
  assert.ok(!isSelfChat({ key: { fromMe: false, remoteJid: '393330000000@s.whatsapp.net' } }, user)); // someone else writing
  assert.ok(!isSelfChat({ key: { fromMe: true, remoteJid: '111-1@g.us' } }, user)); // bot's own group message
  assert.ok(!isSelfChat({ key: { fromMe: true, remoteJid: '393339999999@s.whatsapp.net' } }, user)); // owner's chat with another person
});

// Text extraction from both message shapes.
test('extractMessageText', () => {
  assert.equal(extractMessageText({ message: { conversation: '!stato' } }), '!stato'); // simple text
  assert.equal(extractMessageText({ message: { extendedTextMessage: { text: '!mappa' } } }), '!mappa'); // extended text
  assert.equal(extractMessageText({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: '!stato' } } } } }), '!stato'); // disappearing messages on
  assert.equal(extractMessageText({ message: { imageMessage: {} } }), ''); // ignored type
});

// Group listing, mapping by index, validation and unmapping.
test('!gruppi then !associa / !dissocia', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, targetNames: names, session: {} }; // command context
  const list = await handleCommand('!gruppi', ctx); // list groups
  assert.match(list, /^1\. Alfa 🏘️ \(bacheca\)\n {3}222-2@g\.us\n2\. Zeta 🏘️/); // sorted, community parent hidden
  assert.match(await handleCommand('!associa 1 ateneo', ctx), /Collegato/); // map by index
  assert.match(await handleCommand('!associa 2 nope', ctx), /sconosciuti/); // unknown target refused
  assert.match(await handleCommand('!associa 393331112222@s.whatsapp.net giuri', ctx), /^Uso/); // person JID refused
  assert.deepEqual(
    listGroupLinks(db).map((m) => ({ ...m })),
    [{ target: 'ateneo', jid: '222-2@g.us' }],
  ); // only the valid mapping (rows have a null prototype)
  assert.match(await handleCommand('!dissocia 1 ateneo', ctx), /Scollegato/); // unmap
  assert.equal(listGroupLinks(db).length, 0); // gone
});

// Non-commands are ignored; pause/resume toggles the flag; test previews the latest notice.
test('misc commands', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, targetNames: names, session: {} }; // command context
  assert.equal(await handleCommand('ciao', ctx), null); // not a command
  await handleCommand('!pausa', ctx); // pause
  assert.equal(getStateValue(db, 'paused'), '1'); // flag set
  await handleCommand('!riprendi', ctx); // resume
  assert.equal(getStateValue(db, 'paused'), '0'); // flag cleared
  upsertNotices(db, 'giuri', [{ url: 'https://diges.unicz.it/avviso/1', title: 'Lezione', body: 'x' }], true); // a notice
  assert.match(await handleCommand('!test giuri', ctx), /Anteprima[\s\S]*Lezione/); // preview text
  assert.match(await handleCommand('!test <Giuri>.', ctx), /Anteprima/); // brackets, final dot and capital letter tolerated
  assert.match(await handleCommand('!test', ctx), /Uso: !test/); // missing target
  assert.match(await handleCommand('!test\u200bgiuri', ctx), /Anteprima/); // zero-width space between command and target
  assert.match(await handleCommand('!test gi\u00adx', ctx), /ricevuto: gi\[U\+AD\]x/); // invisible characters spelled out
  assert.match(await handleCommand('!prova nope', ctx), /Target sconosciuto: nope/); // unknown target
  assert.match(await handleCommand('!prova', ctx), /Niente da mettere in coda/); // no mapping yet
  linkGroup(db, 'giuri', '1@g.us'); // link a group
  assert.match(await handleCommand('!prova giuri', ctx), /1 messaggi di prova in coda/); // queued
  assert.match(await handleCommand('!svuota', ctx), /Coda svuotata: 1 messaggi annullati/); // the !prova message is dropped
  assert.match(await handleCommand('!stato', ctx), /In coda: 0/); // empty queue
  assert.match(await handleCommand('!stato', ctx), /Invii: ▶️ attivi/); // status text
  assert.match(await handleCommand('!xyz', ctx), /sconosciuto/); // unknown command
});

// Phone auto-capitalisation must never turn a link into an unlink.
test('capitalised commands and targets', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, targetNames: names, session: {} }; // command context
  await handleCommand('!Gruppi', ctx); // list groups
  assert.equal(await handleCommand('!Associa 1 Ateneo', ctx), '✅ Collegato a "Alfa": ateneo'); // linked, group name shown
  assert.equal(listGroupLinks(db).length, 1); // really stored
  assert.match(await handleCommand('!DISSOCIA 1 ateneo', ctx), /Scollegato/); // unlink in any case
  assert.equal(listGroupLinks(db).length, 0); // gone
  assert.match(await handleCommand('!Test Giuri', ctx), /Nessun avviso/); // target accepted case-insensitively
});

// Links are checked against the groups the bot is really in; !mappa flags broken ones.
test('!associa verifies the group and !mappa flags broken links', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, targetNames: names, session: {} }; // command context
  assert.match(await handleCommand('!associa 1 giuri', ctx), /^Uso/); // index without a previous !gruppi
  assert.match(await handleCommand('!associa 555-5@g.us giuri', ctx), /non è in questo gruppo/); // JID typo / bot not a member
  assert.match(await handleCommand('!associa 999@g.us giuri', ctx), /community/); // community parent cannot receive messages
  assert.equal(listGroupLinks(db).length, 0); // nothing stored by the refusals
  linkGroup(db, 'giuri', '555-5@g.us'); // an old link to a group the bot has left
  await handleCommand('!gruppi', ctx); // list groups
  await handleCommand('!associa 2 giuri', ctx); // Zeta
  const map = await handleCommand('!mappa', ctx); // mapping table
  assert.match(map, /giuri → Zeta\n {3}111-1@g\.us/); // healthy link with its name
  assert.match(map, /giuri → ⚠️ bot non più nel gruppo\n {3}555-5@g\.us/); // broken link flagged
});

// A course removed from sources.json can still be unlinked, but not linked again.
test('!dissocia accepts targets that are only in the mapping', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, targetNames: names, session: {} }; // command context
  linkGroup(db, 'vecchio_corso', '111-1@g.us'); // link to a removed course
  assert.match(await handleCommand('!dissocia 111-1@g.us vecchio_corso', ctx), /Scollegato/); // allowed
  assert.equal(listGroupLinks(db).length, 0); // gone
  assert.match(await handleCommand('!associa 111-1@g.us vecchio_corso', ctx), /sconosciuti/); // unknown for new links
});

// Ids typed on a phone keep only [a-z0-9_].
test('normalizeTargetId', () => {
  assert.equal(normalizeTargetId('<Infermieristica>.'), 'infermieristica'); // brackets copied from the help, final dot
  assert.equal(normalizeTargetId('farmacia\u200b'), 'farmacia'); // zero-width space from the keyboard
  assert.equal(normalizeTargetId(undefined), ''); // missing argument
});

// Names typed on a phone match the sources.json names regardless of case, accents, apostrophe style and spaces.
test('normalizeGroupName', () => {
  assert.equal(normalizeGroupName('  TECNICHE della Prevenzione nell’Ambiente  '), normalizeGroupName("Tecniche della Prevenzione nell'Ambiente")); // curly apostrophe
  assert.equal(normalizeGroupName('Università'), 'universita'); // accents
  assert.notEqual(normalizeGroupName('Sociologia'), normalizeGroupName('Sociologia e Servizio Sociale')); // exact name, not prefix
});

// Courses are linked to the groups named like them; ambiguous and missing ones are reported, never guessed.
test('autoLinkGroups and !autoassocia', async () => {
  const db = openDb(':memory:'); // fresh DB
  const courses = new Map([
    ['giuri', 'Giurisprudenza'],
    ['bio_amb', "Scienze Biologiche per l'Ambiente (Interateneo)"],
    ['doppio', 'Doppio'],
    ['eco', 'Economia Aziendale'],
    ['assente', 'Corso Senza Gruppo'],
  ]); // course id -> name from sources.json
  const groups = {
    a: { id: '1-1@g.us', subject: 'GIURISPRUDENZA' }, // upper case
    b: { id: '2-2@g.us', subject: ' scienze biologiche per l’ambiente  (interateneo)' }, // phone typing
    c: { id: '3-3@g.us', subject: 'Doppio' },
    d: { id: '4-4@g.us', subject: 'doppio' }, // same name twice
    e: { id: '5-5@g.us', subject: 'Economia Aziendale' },
    f: { id: '6-6@g.us', subject: 'Corso Senza Gruppo', isCommunity: true }, // community parent: never linked
  };
  const fake = { groupFetchAllParticipating: async () => groups }; // fake socket
  linkGroup(db, 'eco', '9-9@g.us'); // linked by hand before: must stay as it is
  const r = await autoLinkGroups({ db, sock: fake, groupNamesByTarget: courses, force: false }); // automatic run at connection
  assert.deepEqual(r.linked, [
    ['giuri', 'GIURISPRUDENZA'],
    ['bio_amb', ' scienze biologiche per l’ambiente  (interateneo)'],
  ]); // exact-name matches
  assert.equal(r.already, 1); // eco untouched
  assert.deepEqual(r.ambiguous, [['doppio', 'Doppio']]); // two candidates: not guessed
  assert.deepEqual(r.missing, [['assente', 'Corso Senza Gruppo']]); // community parent ignored
  assert.ok(listGroupLinks(db).some((m) => m.target === 'eco' && m.jid === '9-9@g.us')); // manual link kept

  const ctx = { db, sock: fake, targetNames: new Map(courses), session: {}, groupNamesByTarget: courses }; // command context
  await handleCommand('!dissocia 1-1@g.us giuri', ctx); // owner removes an automatic link on purpose
  assert.equal((await autoLinkGroups({ db, sock: fake, groupNamesByTarget: courses, force: false })).linked.length, 0); // next connection respects it
  const reply = await handleCommand('!AutoAssocia', ctx); // explicit request
  assert.match(reply, /^🔗 \*Associazione automatica/); // never starts with "!"
  assert.match(reply, /✅ Collegati ora \(1\):\n• GIURISPRUDENZA → giuri/); // re-linked on request
  assert.match(reply, /⚠️ Più gruppi con lo stesso nome[\s\S]*• Doppio/); // ambiguity reported
  assert.match(reply, /❓ Nessun gruppo con il nome del corso \(1\):\n• Corso Senza Gruppo/); // missing reported
});

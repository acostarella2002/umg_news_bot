// Unit tests for src/whatsapp/commands.js with a fake socket.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb, listMappings, getKv, upsertNotices, mapGroup } from '../src/db.js'; // storage
import { handleCommand, isSelfChat, textOf } from '../src/whatsapp/commands.js'; // module under test

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

// Only fromMe messages in the self chat count, in both JID forms.
test('isSelfChat', () => {
  assert.ok(isSelfChat({ key: { fromMe: true, remoteJid: '393330000000@s.whatsapp.net' } }, user)); // phone-number form
  assert.ok(isSelfChat({ key: { fromMe: true, remoteJid: '123456@lid' } }, user)); // LID form
  assert.ok(!isSelfChat({ key: { fromMe: false, remoteJid: '393330000000@s.whatsapp.net' } }, user)); // someone else writing
  assert.ok(!isSelfChat({ key: { fromMe: true, remoteJid: '111-1@g.us' } }, user)); // bot's own group message
  assert.ok(!isSelfChat({ key: { fromMe: true, remoteJid: '393339999999@s.whatsapp.net' } }, user)); // owner's chat with another person
});

// Text extraction from both message shapes.
test('textOf', () => {
  assert.equal(textOf({ message: { conversation: '!stato' } }), '!stato'); // simple text
  assert.equal(textOf({ message: { extendedTextMessage: { text: '!mappa' } } }), '!mappa'); // extended text
  assert.equal(textOf({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: '!stato' } } } } }), '!stato'); // disappearing messages on
  assert.equal(textOf({ message: { imageMessage: {} } }), ''); // ignored type
});

// Group listing, mapping by index, validation and unmapping.
test('!gruppi then !associa / !dissocia', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, names, state: {} }; // command context
  const list = await handleCommand('!gruppi', ctx); // list groups
  assert.match(list, /^1\. Alfa 🏘️ \(bacheca\)\n {3}222-2@g\.us\n2\. Zeta 🏘️/); // sorted, community parent hidden
  assert.match(await handleCommand('!associa 1 ateneo', ctx), /Collegato/); // map by index
  assert.match(await handleCommand('!associa 2 nope', ctx), /sconosciuti/); // unknown target refused
  assert.match(await handleCommand('!associa 393331112222@s.whatsapp.net giuri', ctx), /^Uso/); // person JID refused
  assert.deepEqual(
    listMappings(db).map((m) => ({ ...m })),
    [{ target: 'ateneo', jid: '222-2@g.us' }],
  ); // only the valid mapping (rows have a null prototype)
  assert.match(await handleCommand('!dissocia 1 ateneo', ctx), /Scollegato/); // unmap
  assert.equal(listMappings(db).length, 0); // gone
});

// Non-commands are ignored; pause/resume toggles the flag; test previews the latest notice.
test('misc commands', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, names, state: {} }; // command context
  assert.equal(await handleCommand('ciao', ctx), null); // not a command
  await handleCommand('!pausa', ctx); // pause
  assert.equal(getKv(db, 'paused'), '1'); // flag set
  await handleCommand('!riprendi', ctx); // resume
  assert.equal(getKv(db, 'paused'), '0'); // flag cleared
  upsertNotices(db, 'giuri', [{ url: 'https://diges.unicz.it/avviso/1', title: 'Lezione', body: 'x' }], true); // a notice
  assert.match(await handleCommand('!test giuri', ctx), /Anteprima[\s\S]*Lezione/); // preview text
  assert.match(await handleCommand('!stato', ctx), /Invii: ▶️ attivi/); // status text
  assert.match(await handleCommand('!xyz', ctx), /sconosciuto/); // unknown command
});

// Phone auto-capitalisation must never turn a link into an unlink.
test('capitalised commands and targets', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, names, state: {} }; // command context
  await handleCommand('!Gruppi', ctx); // list groups
  assert.equal(await handleCommand('!Associa 1 Ateneo', ctx), '✅ Collegato a "Alfa": ateneo'); // linked, group name shown
  assert.equal(listMappings(db).length, 1); // really stored
  assert.match(await handleCommand('!DISSOCIA 1 ateneo', ctx), /Scollegato/); // unlink in any case
  assert.equal(listMappings(db).length, 0); // gone
  assert.match(await handleCommand('!Test Giuri', ctx), /Nessun avviso/); // target accepted case-insensitively
});

// Links are checked against the groups the bot is really in; !mappa flags broken ones.
test('!associa verifies the group and !mappa flags broken links', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, names, state: {} }; // command context
  assert.match(await handleCommand('!associa 1 giuri', ctx), /^Uso/); // index without a previous !gruppi
  assert.match(await handleCommand('!associa 555-5@g.us giuri', ctx), /non è in questo gruppo/); // JID typo / bot not a member
  assert.match(await handleCommand('!associa 999@g.us giuri', ctx), /community/); // community parent cannot receive messages
  assert.equal(listMappings(db).length, 0); // nothing stored by the refusals
  mapGroup(db, 'giuri', '555-5@g.us'); // an old link to a group the bot has left
  await handleCommand('!gruppi', ctx); // list groups
  await handleCommand('!associa 2 giuri', ctx); // Zeta
  const map = await handleCommand('!mappa', ctx); // mapping table
  assert.match(map, /giuri → Zeta\n {3}111-1@g\.us/); // healthy link with its name
  assert.match(map, /giuri → ⚠️ bot non più nel gruppo\n {3}555-5@g\.us/); // broken link flagged
});

// A course removed from sources.json can still be unlinked, but not linked again.
test('!dissocia accepts targets that are only in the mapping', async () => {
  const db = openDb(':memory:'); // fresh DB
  const ctx = { db, sock, names, state: {} }; // command context
  mapGroup(db, 'vecchio_corso', '111-1@g.us'); // link to a removed course
  assert.match(await handleCommand('!dissocia 111-1@g.us vecchio_corso', ctx), /Scollegato/); // allowed
  assert.equal(listMappings(db).length, 0); // gone
  assert.match(await handleCommand('!associa 111-1@g.us vecchio_corso', ctx), /sconosciuti/); // unknown for new links
});

// End-to-end flow: notice boards -> poller -> owner links groups -> sender delivers to the right WhatsApp groups.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { openDb } from '../src/db.js'; // storage
import { pollOnce } from '../src/poller.js'; // board polling
import { feedList } from '../src/server.js'; // target names, built as in index.js
import { handleCommand } from '../src/whatsapp/commands.js'; // owner commands
import { createSender } from '../src/whatsapp/sender.js'; // delivery queue

// Two courses of one school, the school board and a feed.
const sources = {
  courses: [
    { id: 'giuri', name: 'Giurisprudenza', school: 'diges', url: 'https://diges.unicz.it/corso_studio/giurisprudenza/avvisi' },
    { id: 'economia', name: 'Economia Aziendale', school: 'diges', url: 'https://diges.unicz.it/corso_studio/economia_aziendale/avvisi' },
  ],
  schools: [{ id: 'diges', name: 'Dipartimento DiGES', url: 'https://diges.unicz.it/avvisi' }],
  feeds: [{ id: 'fondazione', name: 'Fondazione UMG - Bandi', url: 'https://www.fondazioneumg.it/feed' }],
};
const names = new Map(
  feedList(sources)
    .filter((f) => f.id !== 'all')
    .map((f) => [f.id, f.name]),
); // same as index.js

// CMS table row, RSS item and diges detail page builders.
const row = (path, title) => `<tr><td>08/10/2026 10:00:00</td><td><a href="https://diges.unicz.it/${path}">${title}</a></td><td></td></tr>`;
const item = (id, title) => `<item><title>${title}</title><link>https://www.fondazioneumg.it/bandi/${id}</link><description>bando</description></item>`;
const detail = (text) => `<div class="my-5" style="text-align:justify;"><p>${text}</p></div>`;

// Fake WhatsApp account in three groups of the community (plus the community itself).
const sent = []; // [jid, text]
const sock = {
  user: { id: '393330000000:5@s.whatsapp.net' }, // the bot account (fake number)
  groupFetchAllParticipating: async () => ({
    a: { id: '111-1@g.us', subject: 'Giurisprudenza', linkedParent: '999@g.us' },
    b: { id: '222-2@g.us', subject: 'Economia', linkedParent: '999@g.us' },
    c: { id: '333-3@g.us', subject: 'Bacheca', isCommunityAnnounce: true, linkedParent: '999@g.us' },
    d: { id: '999@g.us', subject: 'UMG automated news', isCommunity: true },
  }),
  sendPresenceUpdate: async () => {}, // typing indicator
  sendMessage: async (jid, m) => void sent.push([jid, m.text]), // record
};

test('a new notice reaches exactly the linked groups, once each', async () => {
  const db = openDb(':memory:'); // fresh DB
  const pages = {
    [sources.courses[0].url]: `<table>${row('avviso_didattica/1', 'Vecchio giuri')}</table>`,
    [sources.courses[1].url]: `<table>${row('avviso_didattica/9', 'Vecchio eco')}</table>`,
    [sources.schools[0].url]: `<table>${row('avviso/50', 'Vecchio dip')}${row('avviso_personale/7', 'Solo personale')}</table>`,
    [sources.feeds[0].url]: `<rss><channel>${item(1, 'Vecchio bando')}</channel></rss>`,
  }; // what the sites show before the bot starts
  // Fake fetcher serving the pages above.
  const fetchText = async (url) => {
    if (!(url in pages)) throw new Error(`HTTP 404 for ${url}`); // unknown page
    return pages[url]; // canned page
  };
  await pollOnce({ db, sources, fetchText, log: {} }); // first run: silent seed

  // Owner links the groups from the self chat (sorted list: 1 Bacheca, 2 Economia, 3 Giurisprudenza).
  const ctx = { db, sock, names, state: {} }; // command context
  await handleCommand('!gruppi', ctx);
  assert.match(await handleCommand('!Associa 3 giuri', ctx), /Collegato a "Giurisprudenza"/); // auto-capitalised by the phone
  assert.match(await handleCommand('!associa 2 economia', ctx), /Collegato a "Economia"/);
  assert.match(await handleCommand('!associa 1 fondazione', ctx), /Collegato a "Bacheca"/);

  // New notices appear: one per course page, one school notice (also listed on the giuri page), one bando.
  pages[sources.courses[0].url] =
    `<table>${row('avviso_didattica/2', 'Lezione spostata')}${row('avviso/51', 'Sessione di laurea')}${row('avviso_didattica/1', 'Vecchio giuri')}</table>`;
  pages[sources.courses[1].url] = `<table>${row('avviso_didattica/10', 'Esame eco')}${row('avviso_didattica/9', 'Vecchio eco')}</table>`;
  pages[sources.schools[0].url] = `<table>${row('avviso/51', 'Sessione di laurea')}${row('avviso/50', 'Vecchio dip')}</table>`;
  pages[sources.feeds[0].url] = `<rss><channel>${item(2, 'Nuovo bando')}${item(1, 'Vecchio bando')}</channel></rss>`;
  pages['https://diges.unicz.it/avviso_didattica/2'] = detail('Aula 3');
  pages['https://diges.unicz.it/avviso_didattica/10'] = detail('Rinviato');
  pages['https://diges.unicz.it/avviso/51'] = detail('Calendario');
  const s = await pollOnce({ db, sources, fetchText, log: {} }); // second run
  assert.equal(s.errors, 0); // every board read
  assert.equal(s.details, 3); // CMS bodies fetched (the RSS item already has one)

  const cfg = { sendMinDelayS: 1, sendMaxDelayS: 1, maxSendsPerHour: 40 }; // pacing irrelevant here
  const sender = createSender({ db, getSock: () => sock, names, cfg, sleep: async () => {} }); // no real waiting
  while ((await sender.sendNext()) === 'sent'); // drain the queue
  assert.equal(await sender.sendNext(), 'idle'); // nothing left

  const got = sent.map(([jid, text]) => `${jid} ${text.split('\n')[0]} ${text.split('\n').at(-1)}`).sort(); // group, header, link
  assert.deepEqual(got, [
    '111-1@g.us 📢 *Giurisprudenza* 🔗 https://diges.unicz.it/avviso/51', // school notice, once despite two sources
    '111-1@g.us 📢 *Giurisprudenza* 🔗 https://diges.unicz.it/avviso_didattica/2', // course notice
    '222-2@g.us 📢 *Economia Aziendale* 🔗 https://diges.unicz.it/avviso/51', // school fan-out to the other course
    '222-2@g.us 📢 *Economia Aziendale* 🔗 https://diges.unicz.it/avviso_didattica/10', // its own notice
    '333-3@g.us 📢 *Fondazione UMG* 🔗 https://www.fondazioneumg.it/bandi/2', // feed to the community board
  ]);
  assert.ok(sent.every(([, text]) => !/Vecchio|personale/.test(text))); // seeded and staff-only notices never sent
  assert.match(sent.find(([, t]) => t.includes('avviso_didattica/2'))[1], /Aula 3/); // body from the detail page
});

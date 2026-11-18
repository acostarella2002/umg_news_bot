// Unit tests for src/whatsapp/format.js.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { formatNotice, markAsUpdate, validateTemplate } from '../src/whatsapp/format.js'; // module under test

// A template using every placeholder (the layout used until 2026-10-14).
const full = validateTemplate({
  lines: ['📢 *{bacheca}*', '*{titolo}*', '🗓️ {data}', '', '{testo}', '', '📎 *Allegati*\n{allegati}', '', '🔗 {link}'],
  attachment: '• {nome}: {url}',
  maxBody: 700,
});

// Full notice renders every section in order.
test('formatNotice renders all parts', () => {
  const msg = formatNotice(
    {
      url: 'https://medicina.unicz.it/avviso_didattica/1',
      title: 'Esame *spostato*',
      published: '2026-10-08T16:57:04.000Z',
      body: 'Testo',
      attachments: [{ name: 'a.pdf', url: 'https://medicina.unicz.it/scarica_allegato/1' }],
    }, // notice
    'Infermieristica', // board name
    full, // explicit template
  );
  assert.equal(
    msg,
    '📢 *Infermieristica*\n*Esame spostato*\n🗓️ 08/10/2026, 18:57\n\nTesto\n\n📎 *Allegati*\n• a.pdf: https://medicina.unicz.it/scarica_allegato/1\n\n🔗 https://medicina.unicz.it/avviso_didattica/1', // expected text
  );
});

// Long bodies are cut on a word boundary with an ellipsis; empty parts are omitted.
test('formatNotice truncates and skips empty parts', () => {
  const msg = formatNotice({ url: 'https://x.unicz.it/1', title: 'T', published: null, body: 'parola '.repeat(300), attachments: [] }, 'B', full); // long body, no date
  assert.ok(msg.includes('parola…')); // ends on a full word
  assert.ok(!msg.includes('🗓️') && !msg.includes('📎')); // no date, no attachments section
  assert.ok(msg.length < 800); // bounded size
});

// The template shipped in config/message.json (format chosen by the owner on 2026-10-14).
test('formatNotice with the shipped template', () => {
  const n = { url: 'https://www.medicina.unicz.it/avviso_didattica/10208', title: 'Tirocinio *II* ANNO', body: 'Si riporta in allegato…', attachments: [] }; // sample
  assert.equal(
    formatNotice(n, 'Infermieristica'),
    '*‼️TIROCINIO II ANNO ‼️*\n\nSi riporta in allegato…\n\nhttps://www.medicina.unicz.it/avviso_didattica/10208\n\n*#PrimaveraStudentescaUMG*🌸',
  ); // exact text
  assert.equal(
    formatNotice({ ...n, body: '' }, 'B'),
    '*‼️TIROCINIO II ANNO ‼️*\n\nhttps://www.medicina.unicz.it/avviso_didattica/10208\n\n*#PrimaveraStudentescaUMG*🌸',
  ); // no body: no double gap
  const accented = formatNotice({ ...n, title: 'Lezione è _spostata_: già a *Città* ß', body: 'è già così' }, 'B'); // accents, markup characters and body
  assert.ok(accented.startsWith('*‼️LEZIONE È SPOSTATA: GIÀ A CITTÀ SS ‼️*\n')); // capitals keep the accents, markup is stripped, the whole line is bold
  assert.ok(accented.includes('\nè già così\n')); // the body is left as it is
  assert.equal(formatNotice({ ...n, title: '' }, 'B').startsWith('‼️'), false); // no title: no empty "‼️ ‼️" line
  assert.match(
    formatNotice({ ...n, title: 'Titolo' }, 'B', validateTemplate({ lines: ['{titolo}|{TITOLO}'], attachment: '', maxBody: 5 })),
    /^Titolo\|TITOLO$/,
  ); // both placeholders exist
});

// An update is the label followed by the unchanged message.
test('markAsUpdate', () => {
  assert.equal(markAsUpdate('*📢Titolo*\n\nTesto'), 'Aggiornamento in:\n\n*📢Titolo*\n\nTesto'); // exact text
});

// A custom template is applied as written; typos in placeholders are rejected at startup.
test('formatNotice with a custom template', () => {
  const t = validateTemplate({ lines: ['{titolo} ({bacheca})', '{data}', '{link}'], attachment: '{nome}', maxBody: 10 }); // minimal template
  assert.equal(
    formatNotice({ url: 'https://x.unicz.it/1', title: 'T {link}', published: null, body: '', attachments: [] }, 'B', t),
    'T {link} (B)\nhttps://x.unicz.it/1',
  ); // no date line, values not re-expanded
  assert.throws(() => validateTemplate({ lines: ['{titlo}'], attachment: '', maxBody: 1 }), /unknown placeholders \{titlo\}/); // typo
  assert.throws(() => validateTemplate({ lines: 'x' }), /needs lines/); // wrong shape
});

// A "_" is part of many addresses: the real case was a Google form whose link lost it and no longer opened.
test('links keep their underscores and other markup characters', () => {
  const form = 'https://docs.google.com/forms/d/e/1FAIpQLSf7ABpcEGGDTkwbp0h47UGge4HIrr7rf-WaW6wOFjP_vQWOPQ/viewform?usp=publish-editor'; // from notice 10586
  const pdf = 'http://www.fondazioneumg.it/bandi/avviso_1_del_10.06.2026_148_7266.pdf'; // several underscores
  const board = 'https://www.diges.unicz.it/corso_studio/avviso_didattica/833'; // underscores in the path
  const body = `Compila il form _subito_:\n${form}\nvedi (${pdf}) e ~${board}~`; // markup around and between the links
  const message = formatNotice({ url: 'https://medicina.unicz.it/avviso_didattica/10586', title: 'Convegno', body, attachments: [] }, 'B'); // shipped template
  assert.ok(message.includes(form)); // intact, with its "_" and its query string
  assert.ok(message.includes(`(${pdf})`)); // intact inside brackets
  assert.ok(message.includes(` ${board}\n`)); // the strike markers around it are gone, the address is whole
  assert.ok(message.includes('Compila il form subito:')); // markup outside links is still stripped
  assert.ok(message.includes('https://medicina.unicz.it/avviso_didattica/10586')); // the notice link was never touched
  const wrapped = formatNotice(
    { url: 'https://x.unicz.it/1', title: 'T', body: '_https://x.unicz.it/a_b_ e *https://x.unicz.it/c_d* e `https://x.unicz.it/e_f`', attachments: [] },
    'B',
  ); // links wrapped in markup
  assert.ok(wrapped.includes('https://x.unicz.it/a_b e https://x.unicz.it/c_d e https://x.unicz.it/e_f\n')); // the wrapping goes, the inner "_" stays
});

// Titles, attachment names and the capitals must not damage a link either.
test('links in titles and attachment names', () => {
  const link = 'https://docs.google.com/forms/d/e/AbC_dEf/viewform'; // case matters
  const message = formatNotice(
    {
      url: 'https://x.unicz.it/1',
      title: `Iscrizioni ${link} aperte`,
      body: 'Testo',
      attachments: [{ name: `Modulo ${link}`, url: 'https://x.unicz.it/scarica_allegato/1' }],
    },
    'B',
    {
      lines: ['*{TITOLO}*', '{allegati}'],
      attachment: '• {nome}: {url}',
      maxBody: 50,
    },
  ); // a title with a link, an attachment named with a link
  assert.ok(message.startsWith(`*ISCRIZIONI ${link} APERTE*`)); // capitals around the link, never inside it
  assert.ok(message.includes(`• Modulo ${link}: https://x.unicz.it/scarica_allegato/1`)); // the attachment keeps its own address
});

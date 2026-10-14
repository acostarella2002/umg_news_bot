// Unit tests for src/whatsapp/format.js.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { formatNotice, checkTemplate } from '../src/whatsapp/format.js'; // module under test

// A template using every placeholder (the layout used until 2026-10-14).
const full = checkTemplate({
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
    '*📢Tirocinio II ANNO*\n\nSi riporta in allegato…\n\nhttps://www.medicina.unicz.it/avviso_didattica/10208\n\n*#PrimaveraStudentescaUMG*🌸',
  ); // exact text
  assert.equal(
    formatNotice({ ...n, body: '' }, 'B'),
    '*📢Tirocinio II ANNO*\n\nhttps://www.medicina.unicz.it/avviso_didattica/10208\n\n*#PrimaveraStudentescaUMG*🌸',
  ); // no body: no double gap
});

// A custom template is applied as written; typos in placeholders are rejected at startup.
test('formatNotice with a custom template', () => {
  const t = checkTemplate({ lines: ['{titolo} ({bacheca})', '{data}', '{link}'], attachment: '{nome}', maxBody: 10 }); // minimal template
  assert.equal(
    formatNotice({ url: 'https://x.unicz.it/1', title: 'T {link}', published: null, body: '', attachments: [] }, 'B', t),
    'T {link} (B)\nhttps://x.unicz.it/1',
  ); // no date line, values not re-expanded
  assert.throws(() => checkTemplate({ lines: ['{titlo}'], attachment: '', maxBody: 1 }), /unknown placeholders \{titlo\}/); // typo
  assert.throws(() => checkTemplate({ lines: 'x' }), /needs lines/); // wrong shape
});

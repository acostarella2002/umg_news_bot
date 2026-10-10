// Unit tests for src/whatsapp/format.js.
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { formatNotice } from '../src/whatsapp/format.js'; // module under test

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
  );
  assert.equal(
    msg,
    '📢 *Infermieristica*\n*Esame spostato*\n🗓️ 08/10/2026, 18:57\n\nTesto\n\n📎 *Allegati*\n• a.pdf: https://medicina.unicz.it/scarica_allegato/1\n\n🔗 https://medicina.unicz.it/avviso_didattica/1', // expected text
  );
});

// Long bodies are cut on a word boundary with an ellipsis; empty parts are omitted.
test('formatNotice truncates and skips empty parts', () => {
  const msg = formatNotice({ url: 'https://x.unicz.it/1', title: 'T', published: null, body: 'parola '.repeat(300), attachments: [] }, 'B'); // long body, no date
  assert.ok(msg.includes('parola…')); // ends on a full word
  assert.ok(!msg.includes('🗓️') && !msg.includes('📎')); // no date, no attachments section
  assert.ok(msg.length < 800); // bounded size
});

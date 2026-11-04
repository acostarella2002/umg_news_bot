// Unit tests for the reconnect policy of src/whatsapp/client.js (the socket itself needs the real WhatsApp).
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { DisconnectReason } from '@whiskeysockets/baileys'; // real status codes
import { reconnectDelay, isLinked, isSignalSessionLog, requestAndLogPairingCode } from '../src/whatsapp/client.js'; // module under test

// Logout needs a human, a second instance gets a long pause, everything else uses the backoff.
test('reconnectDelay', () => {
  assert.equal(reconnectDelay(DisconnectReason.loggedOut, 5000), null); // never auto-relink
  assert.equal(reconnectDelay(DisconnectReason.loggedOut, 5000, false), 5000); // expired code/QR before linking: retry
  assert.equal(reconnectDelay(DisconnectReason.connectionReplaced, 5000), 15 * 60_000); // no ping-pong with the other instance
  assert.equal(reconnectDelay(DisconnectReason.restartRequired, 5000), 5000); // normal after pairing
  assert.equal(reconnectDelay(DisconnectReason.connectionLost, 20_000), 20_000); // network hiccup
  assert.equal(reconnectDelay(undefined, 5000), 5000); // unknown reason
  assert.equal(reconnectDelay(DisconnectReason.forbidden, 5000), null); // account restricted: stop
  assert.equal(reconnectDelay(DisconnectReason.forbidden, 5000, false), null); // also before the first link
});

// A QR-linked session keeps registered: false for ever (seen in production): a real logout must still stop the bot and keep the session folder.
test('isLinked', () => {
  const qrLinked = { registered: false, account: { details: 'x' } }; // shape of creds.json after a QR link
  assert.equal(isLinked(qrLinked), true); // linked
  assert.equal(reconnectDelay(DisconnectReason.loggedOut, 5000, isLinked(qrLinked)), null); // needs a human
  assert.equal(isLinked({ registered: false, me: { id: 'x' } }), false); // pairing code asked but never entered
});

// A failed pairing request is logged without phone numbers, returns false so the next QR asks again, and never throws.
test('requestAndLogPairingCode', async () => {
  const logged = []; // recorded log lines
  const log = { info: (line) => logged.push(line), error: (fields, line) => logged.push(`${line} ${fields.err}`) }; // fake logger
  const working = { requestPairingCode: async () => 'ABCD1234' }; // fake socket
  assert.equal(await requestAndLogPairingCode(working, '393330000000', log), true); // asked once
  assert.match(logged[0], /PAIRING CODE: ABCD1234/); // the owner can read it
  const closed = { requestPairingCode: async () => Promise.reject(new Error('closed while asking for 393330000000')) }; // socket gone
  assert.equal(await requestAndLogPairingCode(closed, '393330000000', log), false); // no unhandled rejection
  assert.match(logged[1], /pairing code request failed closed while asking for \[number\]/); // logged
  assert.ok(!logged[1].includes('393330000000')); // number scrubbed
});

// libsignal session dumps (with private keys) are dropped from the console; other messages pass.
test('isSignalSessionLog', () => {
  assert.ok(isSignalSessionLog('Closing session:')); // session dump
  assert.ok(isSignalSessionLog('Closing open session in favor of incoming prekey bundle')); // prekey warning
  assert.ok(!isSignalSessionLog('something else')); // unrelated text
  assert.ok(!isSignalSessionLog({ session: 1 })); // non-string first argument
});

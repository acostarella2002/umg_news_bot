// Unit tests for the reconnect policy of src/whatsapp/client.js (the socket itself needs the real WhatsApp).
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { DisconnectReason } from '@whiskeysockets/baileys'; // real status codes
import { reconnectDelay, isSignalNoise } from '../src/whatsapp/client.js'; // module under test

// Logout needs a human, a second instance gets a long pause, everything else uses the backoff.
test('reconnectDelay', () => {
  assert.equal(reconnectDelay(DisconnectReason.loggedOut, 5000), null); // never auto-relink
  assert.equal(reconnectDelay(DisconnectReason.loggedOut, 5000, false), 5000); // expired code/QR before linking: retry
  assert.equal(reconnectDelay(DisconnectReason.connectionReplaced, 5000), 15 * 60_000); // no ping-pong with the other instance
  assert.equal(reconnectDelay(DisconnectReason.restartRequired, 5000), 5000); // normal after pairing
  assert.equal(reconnectDelay(DisconnectReason.connectionLost, 20_000), 20_000); // network hiccup
  assert.equal(reconnectDelay(undefined, 5000), 5000); // unknown reason
});

// libsignal session dumps (with private keys) are dropped from the console; other messages pass.
test('isSignalNoise', () => {
  assert.ok(isSignalNoise('Closing session:')); // session dump
  assert.ok(isSignalNoise('Closing open session in favor of incoming prekey bundle')); // prekey warning
  assert.ok(!isSignalNoise('something else')); // unrelated text
  assert.ok(!isSignalNoise({ session: 1 })); // non-string first argument
});

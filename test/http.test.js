// Unit tests for src/http.js (allowlist and charset decoding).
import { test } from 'node:test'; // built-in test runner
import assert from 'node:assert/strict'; // strict assertions
import { isAllowedUrl, fetchText } from '../src/http.js'; // module under test

// Official hosts and subdomains pass the allowlist.
test('allowlist accepts official hosts', () => {
  assert.ok(isAllowedUrl('https://medicina.unicz.it/avvisi')); // school subdomain
  assert.ok(isAllowedUrl('https://web.unicz.it/it/page/rss')); // university portal
  assert.ok(isAllowedUrl('http://www.fondazioneumg.it/servizi/x')); // foundation site over http
});

// Anything else, including look-alike and internal hosts, is rejected.
test('allowlist rejects other hosts and schemes', () => {
  assert.ok(!isAllowedUrl('https://evilunicz.it/')); // suffix trick without a dot
  assert.ok(!isAllowedUrl('https://unicz.it.evil.com/')); // allowed name used as a subdomain of another host
  assert.ok(!isAllowedUrl('http://169.254.169.254/latest/meta-data')); // cloud metadata endpoint (SSRF)
  assert.ok(!isAllowedUrl('http://localhost:8080/')); // local services
  assert.ok(!isAllowedUrl('file:///etc/passwd')); // local files
  assert.ok(!isAllowedUrl('not a url')); // garbage input
});

// fetchText refuses blocked URLs before any network activity.
test('fetchText throws on blocked host', async () => {
  await assert.rejects(fetchText('https://example.com/'), /blocked host/); // never contacts the host
});

// ISO-8859-1 bodies are decoded correctly when the prolog declares it (Fondazione feeds).
test('fetchText decodes latin1 from xml prolog', async (t) => {
  const body = Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><t>Università</t>', 'latin1'); // à as a single 0xE0 byte
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, // successful response
    url: 'https://www.fondazioneumg.it/feed', // final URL stays on the allowlist
    headers: new Headers({ 'content-type': 'text/xml' }), // no charset in the header
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), // raw bytes
  }));
  assert.match(await fetchText('http://www.fondazioneumg.it/feed'), /Università/); // decoded, not mojibake
});

// A redirect that leaves the allowlist is rejected.
test('fetchText rejects redirects off the allowlist', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, url: 'https://evil.com/', headers: new Headers() })); // simulated redirect target
  await assert.rejects(fetchText('https://medicina.unicz.it/x', { retries: 0 }), /redirected off allowlist/); // refused
});

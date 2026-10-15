// Delivery queue: sends pending notices to their WhatsApp groups slowly and safely.
import { pendingDeliveries, recordDelivery, sentLastHour, getNotice, getKv, sentTwin } from '../db.js'; // storage
import { formatNotice } from './format.js'; // message text
import { redact } from '../redact.js'; // log scrubbing

// Promise-based sleep.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Queue length above which the sender switches to the slow pace (many notices at once).
const BACKLOG = 10;
// Pause before the 2nd and 3rd attempt of a failed message; after the 3rd failure it is given up.
const RETRY_MS = [5 * 60_000, 15 * 60_000];

// Create a sender bound to a DB and a function returning the current socket (or null when offline).
export function createSender({ db, getSock, names, cfg, log = {}, sleep = wait, rand = Math.random, clock = Date.now }) {
  const retries = new Map(); // "url|jid" -> { n: failed attempts, at: earliest retry time }; in memory only, a restart retries at once
  // Random human-like gap; 2-3 minutes by default when a long queue has built up.
  const between = () => {
    const [min, max] = pendingDeliveries(db).length > BACKLOG ? [cfg.slowMinDelayS, cfg.slowMaxDelayS] : [cfg.sendMinDelayS, cfg.sendMaxDelayS]; // pace
    return (min + rand() * (max - min)) * 1000; // milliseconds
  };

  // Try to send exactly one pending message; returns what happened.
  async function sendNext() {
    if (getKv(db, 'paused') === '1') return 'paused'; // owner paused sending with !pausa
    const sock = getSock(); // current connection
    if (!sock) return 'offline'; // not connected yet
    if (sentLastHour(db) >= cfg.maxSendsPerHour) return 'rate'; // hourly cap reached
    const pending = pendingDeliveries(db); // oldest first
    const next = pending.find((p) => !(retries.get(`${p.url}|${p.jid}`)?.at > clock())); // failed ones wait aside without blocking the others
    if (!next) return pending.length ? 'waiting' : 'idle'; // only retries cooling down, or nothing at all
    const key = `${next.url}|${next.jid}`; // retry key
    if (!next.jid.endsWith('@g.us')) {
      recordDelivery(db, next.url, next.jid, 'failed');
      return 'failed';
    } // never message individual people
    if (sentTwin(db, next.url, next.jid)) {
      recordDelivery(db, next.url, next.jid, 'duplicate'); // same title and attachments already sent to this group
      return 'duplicate';
    }
    try {
      const text = formatNotice(getNotice(db, next.url), names.get(next.target) ?? next.target); // build the message
      await sock.sendPresenceUpdate('composing', next.jid); // "typing…" like a human
      await sleep(1500 + rand() * 2500); // short typing time
      await sock.sendMessage(next.jid, { text }); // send to the group
      await sock.sendPresenceUpdate('paused', next.jid); // stop typing
      recordDelivery(db, next.url, next.jid, 'sent'); // remember it
      retries.delete(key); // done
      return 'sent'; // success
    } catch (err) {
      const n = (retries.get(key)?.n ?? 0) + 1; // failed attempts so far
      if (n > RETRY_MS.length) {
        recordDelivery(db, next.url, next.jid, 'failed'); // give up after 3 tries
        retries.delete(key);
      } else retries.set(key, { n, at: clock() + RETRY_MS[n - 1] }); // move to the retry lane
      log.warn?.({ url: next.url, err: redact(err.message) }, 'send failed'); // notice URL only, JIDs redacted
      return 'error'; // the next message goes ahead meanwhile
    }
  }

  // Endless loop: send, then wait a random gap (longer when idle or limited).
  async function run(signal) {
    while (!signal?.aborted) {
      const r = await sendNext(); // one step
      await sleep(r === 'sent' || r === 'error' ? between() : r === 'duplicate' ? 0 : 30_000); // pace the loop; a failure costs one normal gap, a skipped duplicate none
    }
  }

  return { sendNext, run }; // public API
}

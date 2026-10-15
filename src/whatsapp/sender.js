// Delivery queue: sends pending notices to their WhatsApp groups slowly and safely.
import { pendingDeliveries, recordDelivery, countSentLastHour, getNotice, getStateValue, wasIdenticalNoticeSent } from '../db.js'; // storage
import { formatNotice } from './format.js'; // message text
import { redact } from '../redact.js'; // log scrubbing

// Promise-based sleep.
const sleepMs = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// Queue length above which the sender switches to the slow pace (many notices at once).
const SLOW_PACE_QUEUE_LENGTH = 10;
// Pause before the 2nd and 3rd attempt of a failed message; after the 3rd failure it is given up.
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];
// Pause of the loop when there was nothing to send (idle, paused, offline, hourly cap).
const IDLE_PAUSE_MS = 30_000;

// Create a sender bound to a DB and a function returning the current socket (or null when offline).
export function createSender({ db, getSocket, targetNames, config, log = {}, sleep = sleepMs, random = Math.random, clock = Date.now }) {
  const retryStates = new Map(); // "url|jid" -> { failedAttempts, retryAt }; in memory only, a restart retries at once
  // Random human-like gap; 2-3 minutes by default when a long queue has built up.
  const nextPauseMs = () => {
    const [minSeconds, maxSeconds] =
      pendingDeliveries(db).length > SLOW_PACE_QUEUE_LENGTH ? [config.slowMinDelayS, config.slowMaxDelayS] : [config.sendMinDelayS, config.sendMaxDelayS]; // pace
    return (minSeconds + random() * (maxSeconds - minSeconds)) * 1000; // milliseconds
  };

  // Try to send exactly one pending message; returns what happened.
  async function sendNextMessage() {
    if (getStateValue(db, 'paused') === '1') return 'paused'; // owner paused sending with !pausa
    const sock = getSocket(); // current connection
    if (!sock) return 'offline'; // not connected yet
    if (countSentLastHour(db) >= config.maxSendsPerHour) return 'rate'; // hourly cap reached
    const queue = pendingDeliveries(db); // oldest first
    const next = queue.find((delivery) => !(retryStates.get(`${delivery.url}|${delivery.jid}`)?.retryAt > clock())); // failed ones wait aside without blocking the others
    if (!next) return queue.length ? 'waiting' : 'idle'; // only retries cooling down, or nothing at all
    const retryKey = `${next.url}|${next.jid}`; // retry key
    if (!next.jid.endsWith('@g.us')) {
      recordDelivery(db, next.url, next.jid, 'failed');
      return 'failed';
    } // never message individual people
    if (wasIdenticalNoticeSent(db, next.url, next.jid)) {
      recordDelivery(db, next.url, next.jid, 'duplicate'); // same title and attachments already sent to this group
      return 'duplicate';
    }
    try {
      const text = formatNotice(getNotice(db, next.url), targetNames.get(next.target) ?? next.target); // build the message
      await sock.sendPresenceUpdate('composing', next.jid); // "typing…" like a human
      await sleep(1500 + random() * 2500); // short typing time
      await sock.sendMessage(next.jid, { text }); // send to the group
      await sock.sendPresenceUpdate('paused', next.jid); // stop typing
      recordDelivery(db, next.url, next.jid, 'sent'); // remember it
      retryStates.delete(retryKey); // done
      return 'sent'; // success
    } catch (err) {
      const failedAttempts = (retryStates.get(retryKey)?.failedAttempts ?? 0) + 1; // failed attempts so far
      if (failedAttempts > RETRY_DELAYS_MS.length) {
        recordDelivery(db, next.url, next.jid, 'failed'); // give up after 3 tries
        retryStates.delete(retryKey);
      } else retryStates.set(retryKey, { failedAttempts, retryAt: clock() + RETRY_DELAYS_MS[failedAttempts - 1] }); // move to the retry lane
      log.warn?.({ url: next.url, err: redact(err.message) }, 'send failed'); // notice URL only, JIDs redacted
      return 'error'; // the next message goes ahead meanwhile
    }
  }

  // Endless loop: send, then wait a random gap (longer when idle or limited).
  async function run(abortSignal) {
    while (!abortSignal?.aborted) {
      const outcome = await sendNextMessage(); // one step
      await sleep(outcome === 'sent' || outcome === 'error' ? nextPauseMs() : outcome === 'duplicate' ? 0 : IDLE_PAUSE_MS); // a failure costs one normal gap, a skipped duplicate none
    }
  }

  return { sendNextMessage, run }; // public API
}

// Delivery queue: sends pending notices to their WhatsApp groups slowly and safely.
import { pendingDeliveries, recordDelivery, countSentLastHour, getNotice, getStateValue, wasIdenticalNoticeSent, wasSameTextSent } from '../db.js'; // storage
import { formatNotice, markAsUpdate } from './format.js'; // message text
import { redact } from '../redact.js'; // log scrubbing

// Promise-based sleep.
const sleepMs = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// Queue length above which the sender switches to the slow pace (many notices at once).
const SLOW_PACE_QUEUE_LENGTH = 10;
// Pause before the 2nd and 3rd attempt of a failed message; after the 3rd failure it is given up.
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];
// Pause of the loop when there was nothing to send (idle, paused, offline, hourly cap).
const IDLE_PAUSE_MS = 30_000;
// Sent messages remembered while the disk cannot store them; at 40 per hour this is about two days of a full disk.
const MAX_UNSAVED_SENDS = 2000;

// Create a sender bound to a DB and a function returning the current socket (or null when offline).
export function createSender({
  db,
  getSocket,
  targetNames,
  config,
  log = {},
  sleep = sleepMs,
  random = Math.random,
  clock = Date.now,
  maxUnsavedSends = MAX_UNSAVED_SENDS,
}) {
  const retryStates = new Map(); // "url|jid" -> { failedAttempts, retryAt }; in memory only, a restart retries at once
  // Delivered messages whose 'sent' row could not be written yet: "url|jid" -> { url, jid, sentAt }. Without this a full disk would send them again and again.
  // shortcut: in memory only, a restart while the disk is still full can repeat them; move to another store if a full disk ever becomes common.
  const unsavedSends = new Map();
  // Random human-like gap; 2-3 minutes by default when a long queue has built up.
  const nextPauseMs = () => {
    const [minSeconds, maxSeconds] =
      pendingDeliveries(db).length > SLOW_PACE_QUEUE_LENGTH ? [config.slowMinDelayS, config.slowMaxDelayS] : [config.sendMinDelayS, config.sendMaxDelayS]; // pace
    return (minSeconds + random() * (maxSeconds - minSeconds)) * 1000; // milliseconds
  };

  // Write the remembered 'sent' rows; the first failure stops here, because the disk is still full and the rest stay in memory.
  const saveUnsavedSends = () => {
    for (const [retryKey, { url, jid }] of unsavedSends) {
      try {
        recordDelivery(db, url, jid, 'sent'); // remember it for good
        unsavedSends.delete(retryKey); // deleting while iterating a Map is safe
      } catch (err) {
        log.error?.({ url, err: redact(err.message) }, 'sent message not saved, kept in memory'); // notice URL only, JIDs redacted
        return;
      }
    }
  };

  // Try to send exactly one pending message; returns what happened.
  async function sendNextMessage() {
    saveUnsavedSends(); // also while paused or offline: the disk may have free space again
    if (getStateValue(db, 'paused') === '1') return 'paused'; // owner paused sending with !pausa
    const sock = getSocket(); // current connection
    if (!sock) return 'offline'; // not connected yet
    const unsavedLastHour = [...unsavedSends.values()].filter(({ sentAt }) => clock() - sentAt < 36e5).length; // sent for real, but not in the DB count below
    if (countSentLastHour(db) + unsavedLastHour >= config.maxSendsPerHour) return 'rate'; // hourly cap reached
    const queue = pendingDeliveries(db); // oldest first
    const next = queue.find((delivery) => {
      const retryKey = `${delivery.url}|${delivery.jid}`; // retry key
      return !unsavedSends.has(retryKey) && !(retryStates.get(retryKey)?.retryAt > clock()); // already delivered, or failed and waiting aside: the others go ahead
    });
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
      const message = formatNotice(getNotice(db, next.url), targetNames.get(next.target) ?? next.target); // build the message
      const text = wasSameTextSent(db, next.url, next.jid) ? markAsUpdate(message) : message; // same words already in this group: say it is an update
      await sock.sendPresenceUpdate('composing', next.jid); // "typing…" like a human
      await sleep(1500 + random() * 2500); // short typing time
      await sock.sendMessage(next.jid, { text }); // send to the group
    } catch (err) {
      const failedAttempts = (retryStates.get(retryKey)?.failedAttempts ?? 0) + 1; // failed attempts so far
      if (failedAttempts > RETRY_DELAYS_MS.length) {
        recordDelivery(db, next.url, next.jid, 'failed'); // give up after 3 tries
        retryStates.delete(retryKey);
      } else retryStates.set(retryKey, { failedAttempts, retryAt: clock() + RETRY_DELAYS_MS[failedAttempts - 1] }); // move to the retry lane
      log.warn?.({ url: next.url, err: redact(err.message) }, 'send failed'); // notice URL only, JIDs redacted
      return 'error'; // the next message goes ahead meanwhile
    }
    // The message has left: from here on no failure may ever send it again.
    unsavedSends.set(retryKey, { url: next.url, jid: next.jid, sentAt: clock() }); // remembered before writing to disk
    if (unsavedSends.size > maxUnsavedSends) unsavedSends.delete(unsavedSends.keys().next().value); // washout: a Map keeps insertion order, the oldest goes first
    retryStates.delete(retryKey); // done
    await sock.sendPresenceUpdate('paused', next.jid).catch(() => {}); // cosmetic: a failure here must not count as a failed send
    saveUnsavedSends(); // normally writes the row at once
    return 'sent'; // success
  }

  // Endless loop: send, then wait a random gap (longer when idle or limited).
  async function run(abortSignal) {
    while (!abortSignal?.aborted) {
      const outcome = await sendNextMessage().catch((err) => {
        log.error?.({ err: redact(err.message) }, 'sender step failed'); // e.g. disk full: a crash would also lose unsavedSends
        return 'error';
      }); // one step
      await sleep(outcome === 'sent' || outcome === 'error' ? nextPauseMs() : outcome === 'duplicate' ? 0 : IDLE_PAUSE_MS); // a failure costs one normal gap, a skipped duplicate none
    }
  }

  return { sendNextMessage, run }; // public API
}

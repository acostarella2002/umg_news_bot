// WhatsApp connection (Baileys linked device) with privacy-first settings and safe reconnects.
import { mkdirSync, rmSync } from 'node:fs'; // auth folder creation and reset
import qrcode from 'qrcode-terminal'; // draws the link QR in the logs
import pino from 'pino'; // Baileys requires a pino-compatible logger
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestWaWebVersion } from '@whiskeysockets/baileys'; // WhatsApp Web protocol
import { filterOwnerCommands } from './commands.js'; // self-chat filter
import { redact } from '../redact.js'; // log scrubbing

// libsignal (inside Baileys) prints whole Signal sessions, private keys included, with console.info/warn: never let them reach the logs.
export const isSignalSessionLog = (firstArgument) => typeof firstArgument === 'string' && /session|prekey|bucket/i.test(firstArgument); // "Closing session:", "Opening session:"…
for (const level of ['info', 'warn']) {
  const originalWriter = console[level].bind(console); // original writer
  console[level] = (...args) => (isSignalSessionLog(args[0]) ? undefined : originalWriter(...args)); // our own logs go through pino, not console
}

// Pause after another instance took the session over: never ping-pong with it, but recover alone once it is gone.
const REPLACED_PAUSE_MS = 15 * 60_000;
// First reconnect delay and its upper bound (exponential backoff in between).
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 300_000;

// Milliseconds to wait before reconnecting after a close with this status code; null = never (a human must relink).
// A logout before the first link only means the code/QR expired unused: retry with a fresh session.
export const reconnectDelay = (statusCode, retryMs, isRegistered = true) =>
  statusCode === DisconnectReason.loggedOut
    ? isRegistered
      ? null
      : retryMs
    : statusCode === DisconnectReason.connectionReplaced
      ? REPLACED_PAUSE_MS
      : retryMs;

// Start the client; returns getSocket() (live socket or null while disconnected) and getStatus() for /health.
export function startWhatsApp({ authDir, pairingNumber, log, onMessage, onOpen }) {
  mkdirSync(authDir, { recursive: true, mode: 0o700 }); // session keys readable only by the bot user
  let liveSocket = null; // live socket when connected
  let retryMs = FIRST_RETRY_MS; // reconnect backoff, grows up to 5 minutes
  let status = 'connecting'; // connecting | connected | reconnecting | replaced | logged_out | error

  // (Re)connect after `delayMs`; a failure before the socket exists (session files unreadable, disk full) is retried too.
  const scheduleConnect = (delayMs) =>
    setTimeout(
      () =>
        connect().catch((err) => {
          status = 'error'; // visible in /health
          log.error({ err: redact(err.message) }, `whatsapp start failed, retrying in ${retryMs / 1000}s`);
          scheduleConnect(retryMs); // never give up: the RSS keeps running meanwhile
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS); // exponential backoff, capped
        }),
      delayMs,
    );

  // Create one socket and wire its events; called again on reconnect.
  async function connect() {
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir); // persisted session
    const { version } = await fetchLatestWaWebVersion().catch(() => ({})); // current WA Web version, or Baileys default
    const sock = makeWASocket({
      auth: authState, // credentials
      version, // protocol version (undefined -> library default)
      logger: pino({ level: 'silent' }), // Baileys debug logs contain JIDs and contents: never log them
      browser: Browsers.macOS('Desktop'), // standard linked-device fingerprint
      markOnlineOnConnect: false, // do not appear "online" all the time (phone keeps getting notifications)
      syncFullHistory: false, // never download chat history
      shouldSyncHistoryMessage: () => false, // ignore history sync notifications entirely
      getMessage: async () => undefined, // no message store: nothing to re-send
    });
    sock.ev.on('creds.update', saveCreds); // persist key rotation

    let pairingCodeRequested = false; // ask for a pairing code only once per socket
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      const isRegistered = authState.creds.registered; // linked to the phone already?
      if (qr && !isRegistered && !pairingNumber) {
        // not linked yet and no number: show the QR (it refreshes about every 20 s)
        log.info('LINK QR below  ->  on the bot phone: WhatsApp Business > Linked devices > Link a device, scan it');
        qrcode.generate(qr, { small: true }, (drawing) => process.stdout.write(drawing + '\n')); // plain stdout: pino would escape the drawing
      }
      if (qr && !isRegistered && pairingNumber && !pairingCodeRequested) {
        // not linked yet: use a pairing code instead of a QR
        pairingCodeRequested = true; // once
        const pairingCode = await sock.requestPairingCode(pairingNumber); // 8-character code
        log.info(`PAIRING CODE: ${pairingCode}  ->  on the bot phone: WhatsApp Business > Linked devices > Link with phone number`); // shown once in the logs
      }
      if (connection === 'open') {
        liveSocket = sock;
        retryMs = FIRST_RETRY_MS;
        status = 'connected';
        log.info('whatsapp connected');
        Promise.resolve(onOpen?.(sock)).catch((err) => log.error({ err: redact(err.message) }, 'on-connect task failed')); // e.g. automatic group linking
      } // ready
      if (connection === 'close') {
        liveSocket = null; // stop sending
        const statusCode = lastDisconnect?.error?.output?.statusCode; // reason
        const delayMs = reconnectDelay(statusCode, retryMs, isRegistered); // how long to wait, or null
        if (statusCode === DisconnectReason.loggedOut && !isRegistered) {
          rmSync(authDir, { recursive: true, force: true }); // unused half-made session: nothing of value inside
          mkdirSync(authDir, { recursive: true, mode: 0o700 }); // fresh empty folder for the next code/QR
        }
        if (delayMs === null) {
          status = 'logged_out';
          return log.error('whatsapp logged out: delete the wa-auth folder and link again'); // never auto-relink
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
          status = 'replaced'; // two instances share one session (e.g. a copy of data/ started elsewhere): stop the fight
          log.error(`whatsapp session opened by another instance with the same data folder: retrying in ${delayMs / 60_000} min`);
        } else {
          status = 'reconnecting';
          log.warn({ code: statusCode }, `whatsapp closed, reconnecting in ${delayMs / 1000}s`); // transient error
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS); // exponential backoff, capped
        }
        scheduleConnect(delayMs); // retry later
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const message of filterOwnerCommands(messages, sock.user))
        // everything except fresh self-chat messages is ignored, unread, unstored
        Promise.resolve(onMessage(message, sock)).catch((err) => log.error({ err: redact(err.message) }, 'command failed')); // handle command
    });
  }

  scheduleConnect(0); // first connection
  return { getSocket: () => liveSocket, getStatus: () => status }; // accessors used by sender/keepalive and /health
}

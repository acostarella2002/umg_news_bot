// Entry point: RSS server + poller + (optional) WhatsApp sender, commands and weekly keepalive.
import { mkdirSync } from 'node:fs'; // data folder
import { join } from 'node:path'; // paths
import pino from 'pino'; // structured logs
import { config, sources } from './config.js'; // settings
import { openDb } from './db.js'; // storage
import { redact } from './redact.js'; // log scrubbing
import { pollOnce } from './poller.js'; // board polling
import { makeServer, feedList, healthOf } from './server.js'; // RSS HTTP server

// App logger: no hostname/pid, and our code only ever logs public URLs and error messages.
const log = pino({ level: config.logLevel, base: undefined });
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); // private data folder
const db = openDb(join(config.dataDir, 'bot.db')); // persistent DB
const names = new Map(
  feedList(sources)
    .filter((f) => f.id !== 'all')
    .map((f) => [f.id, f.name]),
); // target id -> display name

// RSS server, with /health checking data folder, polls and WhatsApp (read by the Docker HEALTHCHECK).
const startedAt = new Date().toISOString(); // grace period before the first poll completes
let waStatus = () => (config.waEnabled ? 'connecting' : 'disabled'); // replaced once WhatsApp starts
const health = () => healthOf({ db, dataDir: config.dataDir, pollMinutes: config.pollMinutes, startedAt, whatsapp: waStatus() }); // current status
makeServer({ db, sources, baseUrl: config.baseUrl, health }).listen(config.port, () => log.info(`rss server on :${config.port}`)); // start HTTP

// Poll loop without overlapping runs.
let polling = false; // guard flag
const poll = async () => {
  if (polling) return; // previous run still going
  polling = true; // lock
  try {
    log.info(await pollOnce({ db, sources, log }), 'poll done'); // counters only
  } catch (err) {
    log.error({ err: redact(err.message) }, 'poll crashed'); // unexpected error
  } finally {
    polling = false; // unlock
  }
};
poll(); // run immediately at startup
setInterval(poll, config.pollMinutes * 60_000); // then periodically

// WhatsApp part (can be disabled to run RSS-only).
if (config.waEnabled) {
  const { startWhatsApp } = await import('./whatsapp/client.js'); // loaded only when needed
  const { createSender } = await import('./whatsapp/sender.js'); // delivery queue
  const { handleCommand, textOf, autoLink, autoLinkReport } = await import('./whatsapp/commands.js'); // owner commands
  const { keepaliveTick, selfJid } = await import('./whatsapp/keepalive.js'); // weekly reminder
  const state = {}; // command session state (last !gruppi listing)
  const courses = new Map(sources.courses.map((c) => [c.id, c.name])); // course id -> exact group name expected
  const wa = startWhatsApp({
    authDir: join(config.dataDir, 'wa-auth'), // session folder
    pairingNumber: config.waPairingNumber, // bot's own number for the pairing code
    log, // logger
    onMessage: async (msg, sock) => {
      const reply = await handleCommand(textOf(msg), { db, sock, names, state, courses }); // run command
      if (reply) await sock.sendMessage(selfJid(sock.user), { text: reply }); // answer in the self chat only
    },
    // On every connection: link courses to the groups named like them (once per course), then tell the owner.
    onOpen: async (sock) => {
      const r = await autoLink({ db, sock, courses, force: false }); // first-time links only
      if (r.linked.length) await sock.sendMessage(selfJid(sock.user), { text: autoLinkReport(r) }); // silent when nothing changed
    },
  });
  waStatus = wa.getStatus; // /health now reports the real connection state
  createSender({ db, getSock: wa.getSock, names, cfg: config, log }).run(); // start sending loop
  setInterval(
    () => keepaliveTick({ db, sock: wa.getSock(), days: config.keepaliveDays }).catch((e) => log.warn({ err: redact(e.message) }, 'keepalive failed')),
    3_600_000,
  ); // hourly check, weekly send
}

// Clean shutdown for Docker stop.
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    log.info(`${sig} received, exiting`);
    db.close();
    process.exit(0);
  }); // close DB and exit

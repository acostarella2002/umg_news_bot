// Entry point: RSS server + poller + (optional) WhatsApp sender, commands and weekly keepalive.
import { mkdirSync } from 'node:fs'; // data folder
import { join } from 'node:path'; // paths
import pino from 'pino'; // structured logs
import { config, sources } from './config.js'; // settings
import { openDb } from './db.js'; // storage
import { redact } from './redact.js'; // log scrubbing
import { pollOnce } from './poller.js'; // board polling
import { createRssServer, feedList, computeHealth } from './server.js'; // RSS HTTP server

// App logger: no hostname/pid, and our code only ever logs public URLs and error messages.
const log = pino({ level: config.logLevel, base: undefined });
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); // private data folder
const db = openDb(join(config.dataDir, 'bot.db')); // persistent DB
const targetNames = new Map(
  feedList(sources)
    .filter((feed) => feed.id !== 'all')
    .map((feed) => [feed.id, feed.name]),
); // target id -> display name
// Exact WhatsApp group name per target, for !autoassocia: the display name, or the optional "group" field of sources.json.
const groupNamesByTarget = new Map([
  ...targetNames,
  ...[...sources.courses, ...sources.schools, ...sources.feeds].filter((source) => source.group).map((source) => [source.id, source.group]),
]);

// RSS server, with /health checking data folder, polls and WhatsApp (read by the Docker HEALTHCHECK).
const startedAt = new Date().toISOString(); // grace period before the first poll completes
let whatsappStatus = () => (config.waEnabled ? 'connecting' : 'disabled'); // replaced once WhatsApp starts
const health = () => computeHealth({ db, dataDir: config.dataDir, pollMinutes: config.pollMinutes, startedAt, whatsapp: whatsappStatus() }); // current status
createRssServer({ db, sources, baseUrl: config.baseUrl, health }).listen(config.port, () => log.info(`rss server on :${config.port}`)); // start HTTP

// Poll loop without overlapping runs.
let isPolling = false; // guard flag
const poll = async () => {
  if (isPolling) return; // previous run still going
  isPolling = true; // lock
  try {
    log.info(await pollOnce({ db, sources, log }), 'poll done'); // counters only
  } catch (err) {
    log.error({ err: redact(err.message) }, 'poll crashed'); // unexpected error
  } finally {
    isPolling = false; // unlock
  }
};
poll(); // run immediately at startup
setInterval(poll, config.pollMinutes * 60_000); // then periodically

// WhatsApp part (can be disabled to run RSS-only).
if (config.waEnabled) {
  const { startWhatsApp } = await import('./whatsapp/client.js'); // loaded only when needed
  const { createSender } = await import('./whatsapp/sender.js'); // delivery queue
  const { handleCommand, extractMessageText, autoLinkGroups, formatAutoLinkReport, withoutDeviceSuffix } = await import('./whatsapp/commands.js'); // owner commands
  const { sendKeepaliveIfDue } = await import('./whatsapp/keepalive.js'); // weekly reminder
  const commandSession = {}; // command session state (last !gruppi listing)
  const whatsapp = startWhatsApp({
    authDir: join(config.dataDir, 'wa-auth'), // session folder
    pairingNumber: config.waPairingNumber, // bot's own number for the pairing code (empty = QR)
    log, // logger
    onMessage: async (message, sock) => {
      const reply = await handleCommand(extractMessageText(message), { db, sock, targetNames, session: commandSession, groupNamesByTarget }); // run command
      if (reply) await sock.sendMessage(withoutDeviceSuffix(sock.user?.id), { text: reply }); // answer in the self chat only
    },
    // On every connection: link targets to the groups named like them (once per target), then tell the owner.
    onOpen: async (sock) => {
      const result = await autoLinkGroups({ db, sock, groupNamesByTarget, force: false }); // first-time links only
      if (result.linked.length) await sock.sendMessage(withoutDeviceSuffix(sock.user?.id), { text: formatAutoLinkReport(result) }); // silent when nothing changed
    },
  });
  whatsappStatus = whatsapp.getStatus; // /health now reports the real connection state
  createSender({ db, getSocket: whatsapp.getSocket, targetNames, config, log }).run(); // start sending loop
  setInterval(
    () =>
      sendKeepaliveIfDue({ db, sock: whatsapp.getSocket(), intervalDays: config.keepaliveDays }).catch((err) =>
        log.warn({ err: redact(err.message) }, 'keepalive failed'),
      ),
    3_600_000,
  ); // hourly check, weekly send
}

// Clean shutdown for Docker stop.
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    log.info(`${signal} received, exiting`);
    db.close();
    process.exit(0);
  }); // close DB and exit

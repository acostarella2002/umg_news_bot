// Runtime configuration read once from environment variables (see .env.example).
import { readFileSync } from 'node:fs'; // sync read is fine: runs once at startup
import { join } from 'node:path'; // portable path joining

// Read a positive integer env var, falling back to a default when unset or invalid.
const readPositiveInt = (variableName, fallback) => {
  const parsed = Number.parseInt(process.env[variableName] ?? '', 10); // parse the raw string as base-10
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; // reject NaN, zero and negatives
};

// Exported settings object used by every module.
export const config = {
  dataDir: process.env.DATA_DIR || './data', // SQLite DB and WhatsApp session live here
  port: readPositiveInt('PORT', 8080), // HTTP port for the RSS server
  baseUrl: (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''), // public URL used inside feeds
  pollMinutes: readPositiveInt('POLL_MINUTES', 15), // how often notice boards are checked
  waEnabled: process.env.WA_ENABLED !== 'false', // allows running RSS-only without WhatsApp
  waPairingNumber: (process.env.WA_PAIRING_NUMBER || '').replace(/\D/g, ''), // the BOT's own number, digits only
  sendMinDelayS: readPositiveInt('SEND_MIN_DELAY_S', 8), // minimum random pause between WhatsApp messages
  sendMaxDelayS: readPositiveInt('SEND_MAX_DELAY_S', 20), // maximum random pause between WhatsApp messages
  slowMinDelayS: readPositiveInt('SLOW_MIN_DELAY_S', 120), // minimum pause when many notices are queued at once
  slowMaxDelayS: readPositiveInt('SLOW_MAX_DELAY_S', 180), // maximum pause when many notices are queued at once
  maxSendsPerHour: readPositiveInt('MAX_SENDS_PER_HOUR', 40), // hard cap to keep traffic human-like
  keepaliveDays: readPositiveInt('KEEPALIVE_DAYS', 6), // reminder to open the primary phone (WhatsApp unlinks after ~14 days offline)
  logLevel: process.env.LOG_LEVEL || 'info', // pino log level
};

// Notice sources (courses, schools, RSS feeds) loaded from the versioned JSON file.
export const sources = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'sources.json'), 'utf8'));

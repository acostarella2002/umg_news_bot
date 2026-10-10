// SQLite storage (node:sqlite, no native build). Stores ONLY public notices and group routing:
// no phone numbers, names or message contents of any WhatsApp user are ever written here.
import { DatabaseSync } from 'node:sqlite'; // built-in synchronous SQLite driver

// Open (or create) the database and make sure the schema exists.
export function openDb(file) {
  const db = new DatabaseSync(file); // ':memory:' is used by tests
  db.exec(`
    PRAGMA journal_mode = WAL;                -- safe concurrent reads while writing
    CREATE TABLE IF NOT EXISTS notices (
      url TEXT PRIMARY KEY,                   -- canonical public URL, the dedup key
      title TEXT NOT NULL,                    -- notice title
      published TEXT,                         -- ISO date from the source
      updated TEXT,                           -- ISO "last update" from the source
      body TEXT,                              -- plain-text body (filled lazily from the detail page)
      attachments TEXT NOT NULL DEFAULT '[]', -- JSON array of {name,url}
      notify INTEGER NOT NULL,                -- 1 = send to WhatsApp, 0 = seeded on first run (RSS only)
      first_seen TEXT NOT NULL                -- when the bot first saw it
    );
    CREATE TABLE IF NOT EXISTS notice_targets (
      url TEXT NOT NULL,                      -- notice URL
      target TEXT NOT NULL,                   -- course/school/feed id the notice belongs to
      PRIMARY KEY (url, target)
    );
    CREATE TABLE IF NOT EXISTS group_map (
      target TEXT NOT NULL,                   -- course/school/feed id
      jid TEXT NOT NULL,                      -- WhatsApp GROUP id (never a person)
      created_at TEXT NOT NULL,               -- mapping time: older notices are not back-filled
      PRIMARY KEY (target, jid)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      url TEXT NOT NULL,                      -- notice URL
      jid TEXT NOT NULL,                      -- group it was sent to
      status TEXT NOT NULL,                   -- 'sent' or 'failed'
      at TEXT NOT NULL,                       -- timestamp
      PRIMARY KEY (url, jid)
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT); -- small state: seeded sources, last poll, pause flag
  `);
  return db; // ready to use
}

// Current time as ISO string (single place, easy to read).
const now = () => new Date().toISOString();

// Read a value from the key/value table.
export const getKv = (db, k) => db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null; // null when missing
// Write a value into the key/value table.
export const setKv = (db, k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v)); // upsert

// Insert or refresh notices for one or more targets (string or array); returns how many were new.
export function upsertNotices(db, target, items, notify) {
  const ins = db.prepare(
    `INSERT INTO notices (url, title, published, updated, body, attachments, notify, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, updated = excluded.updated`, // keep body/notify, refresh title+date
  );
  const link = db.prepare('INSERT OR IGNORE INTO notice_targets (url, target) VALUES (?, ?)'); // many-to-many link
  const exists = db.prepare('SELECT 1 FROM notices WHERE url = ?'); // novelty check
  let added = 0; // counter of new notices
  db.exec('BEGIN'); // one transaction: fast and atomic
  try {
    for (const n of items) {
      if (!exists.get(n.url)) added++; // count before inserting
      ins.run(n.url, n.title, n.published ?? null, n.updated ?? null, n.body ?? null, JSON.stringify(n.attachments ?? []), notify ? 1 : 0, now()); // store
      for (const t of [].concat(target)) link.run(n.url, t); // attach to each course/school/feed
    }
    db.exec('COMMIT'); // persist everything
  } catch (err) {
    db.exec('ROLLBACK'); // never leave half-written data
    throw err; // let the poller log it
  }
  return added; // used for logging
}

// Notices that should be sent but still miss the detail body.
export const noticesNeedingDetail = (db, limit) => db.prepare('SELECT url FROM notices WHERE notify = 1 AND body IS NULL LIMIT ?').all(limit); // RSS items arrive with a (possibly empty) body, so only CMS pages match

// Save the detail body and attachments of a notice.
export const saveDetail = (db, url, { body, attachments }) =>
  db.prepare('UPDATE notices SET body = ?, attachments = ? WHERE url = ?').run(body, JSON.stringify(attachments), url); // fill lazily

// Pending WhatsApp deliveries: notices to send to groups mapped to their targets.
// Only notices first seen after the mapping and within maxAgeDays are sent (no floods after downtime).
export function pendingDeliveries(db, maxAgeDays = 3) {
  const since = new Date(Date.now() - maxAgeDays * 864e5).toISOString(); // freshness cutoff
  return db
    .prepare(
      `SELECT n.url, g.jid, MIN(g.target) AS target
       FROM notices n
       JOIN notice_targets t ON t.url = n.url
       JOIN group_map g ON g.target = t.target
       LEFT JOIN deliveries d ON d.url = n.url AND d.jid = g.jid
       WHERE n.notify = 1 AND d.url IS NULL AND n.first_seen >= g.created_at AND n.first_seen >= ?
         AND (n.body IS NOT NULL OR n.first_seen < ?)
       GROUP BY n.url, g.jid
       ORDER BY n.first_seen, n.url`, // oldest first, one row per (notice, group)
    )
    .all(since, new Date(Date.now() - 36e5).toISOString()); // wait for the body, but at most 1 hour
}

// Mark a notice as sent (or permanently failed) for one group.
export const recordDelivery = (db, url, jid, status) =>
  db.prepare('INSERT OR REPLACE INTO deliveries (url, jid, status, at) VALUES (?, ?, ?, ?)').run(url, jid, status, now()); // idempotent

// Number of messages sent in the last hour (rate limiting).
export const sentLastHour = (db) =>
  db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE status = 'sent' AND at >= ?").get(new Date(Date.now() - 36e5).toISOString()).c; // rolling window

// Number of deliveries given up in the last 24 hours (broken group links).
export const failedLastDay = (db) =>
  db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE status = 'failed' AND at >= ?").get(new Date(Date.now() - 864e5).toISOString()).c; // rolling window

// True when a notice URL is already stored.
export const isKnown = (db, url) => Boolean(db.prepare('SELECT 1 FROM notices WHERE url = ?').get(url)); // dedup check

// Read one notice with its attachments parsed.
export function getNotice(db, url) {
  const n = db.prepare('SELECT * FROM notices WHERE url = ?').get(url); // single row
  return n && { ...n, attachments: JSON.parse(n.attachments) }; // decode JSON column
}

// Latest notices for a target (or all targets when target is null), newest first.
export const latestNotices = (db, target, limit = 50) =>
  (target
    ? db
        .prepare(
          'SELECT n.* FROM notices n JOIN notice_targets t ON t.url = n.url WHERE t.target = ? ORDER BY COALESCE(n.published, n.first_seen) DESC LIMIT ?',
        )
        .all(target, limit) // one target
    : db.prepare('SELECT * FROM notices ORDER BY COALESCE(published, first_seen) DESC LIMIT ?').all(limit)
  ) // everything
    .map((n) => ({ ...n, attachments: JSON.parse(n.attachments) })); // decode JSON column

// Map a WhatsApp group to a target.
export const mapGroup = (db, target, jid) => db.prepare('INSERT OR IGNORE INTO group_map (target, jid, created_at) VALUES (?, ?, ?)').run(target, jid, now()); // idempotent
// Remove a group mapping.
export const unmapGroup = (db, target, jid) => db.prepare('DELETE FROM group_map WHERE target = ? AND jid = ?').run(target, jid).changes; // rows removed
// All current mappings.
export const listMappings = (db) => db.prepare('SELECT target, jid FROM group_map ORDER BY target').all(); // for !mappa

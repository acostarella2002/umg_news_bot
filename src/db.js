// SQLite storage (node:sqlite, no native build). Stores ONLY public notices and group routing:
// no phone numbers, names or message contents of any WhatsApp user are ever written here.
import { DatabaseSync } from 'node:sqlite'; // built-in synchronous SQLite driver

// Open (or create) the database and make sure the schema exists.
export function openDb(filePath) {
  const db = new DatabaseSync(filePath); // ':memory:' is used by tests
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
      created_at TEXT NOT NULL,               -- link time: older notices are not back-filled
      PRIMARY KEY (target, jid)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      url TEXT NOT NULL,                      -- notice URL
      jid TEXT NOT NULL,                      -- group it was sent to
      status TEXT NOT NULL,                   -- 'sent', 'failed', 'skipped' (!svuota) or 'duplicate' (same notice already sent)
      at TEXT NOT NULL,                       -- timestamp
      PRIMARY KEY (url, jid)
    );
    CREATE TABLE IF NOT EXISTS manual_sends (
      url TEXT NOT NULL,                      -- notice the owner asked to send with !prova
      jid TEXT NOT NULL,                      -- group it goes to
      at TEXT NOT NULL,                       -- request time (same 3-day limit as normal notices)
      PRIMARY KEY (url, jid)
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT); -- small state: seeded sources, last poll, pause flag
  `);
  return db; // ready to use
}

// Current time as ISO string (single place, easy to read).
const nowIso = () => new Date().toISOString();
// ISO timestamp of `milliseconds` ago.
const isoAgo = (milliseconds) => new Date(Date.now() - milliseconds).toISOString();

// Read a value from the key/value state table (null when missing).
export const getStateValue = (db, key) => db.prepare('SELECT v FROM kv WHERE k = ?').get(key)?.v ?? null;
// Write a value into the key/value state table (stored as text).
export const setStateValue = (db, key, value) =>
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value)); // upsert

// Insert or refresh notices for one or more targets (string or array); returns how many were new.
export function upsertNotices(db, targetIds, notices, shouldNotify) {
  const insertNotice = db.prepare(
    `INSERT INTO notices (url, title, published, updated, body, attachments, notify, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, updated = excluded.updated`, // keep body/notify, refresh title+date
  );
  const linkTarget = db.prepare('INSERT OR IGNORE INTO notice_targets (url, target) VALUES (?, ?)'); // many-to-many link
  const noticeExists = db.prepare('SELECT 1 FROM notices WHERE url = ?'); // novelty check
  let addedCount = 0; // counter of new notices
  db.exec('BEGIN'); // one transaction: fast and atomic
  try {
    for (const notice of notices) {
      if (!noticeExists.get(notice.url)) addedCount++; // count before inserting
      insertNotice.run(
        notice.url,
        notice.title,
        notice.published ?? null,
        notice.updated ?? null,
        notice.body ?? null,
        JSON.stringify(notice.attachments ?? []),
        shouldNotify ? 1 : 0,
        nowIso(),
      ); // store
      for (const targetId of [].concat(targetIds)) linkTarget.run(notice.url, targetId); // attach to each course/school/feed
    }
    db.exec('COMMIT'); // persist everything
  } catch (err) {
    db.exec('ROLLBACK'); // never leave half-written data
    throw err; // let the poller log it
  }
  return addedCount; // used for logging
}

// Notices that should be sent but still miss the detail body.
export const noticesNeedingDetail = (db, limit) =>
  db.prepare('SELECT url FROM notices WHERE body IS NULL AND (notify = 1 OR url IN (SELECT url FROM manual_sends)) LIMIT ?').all(limit); // RSS items arrive with a (possibly empty) body, so only CMS pages match

// Save the detail body and attachments of a notice.
export const saveDetail = (db, url, { body, attachments }) =>
  db.prepare('UPDATE notices SET body = ?, attachments = ? WHERE url = ?').run(body, JSON.stringify(attachments), url); // fill lazily

// Pending WhatsApp deliveries: notices to send to the groups linked to their targets.
// Only notices first seen after the link and within maxAgeDays are sent (no floods after downtime),
// plus the ones the owner queued with !prova (requested within maxAgeDays).
// includeWaitingForBody = true also lists the ones still waiting for their body (used by !svuota).
export function pendingDeliveries(db, maxAgeDays = 3, includeWaitingForBody = false) {
  const freshnessCutoff = isoAgo(maxAgeDays * 864e5); // older notices are never sent
  return db
    .prepare(
      `SELECT notice.url, group_link.jid, MIN(group_link.target) AS target
       FROM notices notice
       JOIN notice_targets notice_target ON notice_target.url = notice.url
       JOIN group_map group_link ON group_link.target = notice_target.target
       LEFT JOIN deliveries delivery ON delivery.url = notice.url AND delivery.jid = group_link.jid
       LEFT JOIN manual_sends manual ON manual.url = notice.url AND manual.jid = group_link.jid
       WHERE delivery.url IS NULL
         AND ((notice.notify = 1 AND notice.first_seen >= group_link.created_at AND notice.first_seen >= ?) OR manual.at >= ?)
         AND (? OR notice.body IS NOT NULL OR COALESCE(manual.at, notice.first_seen) < ?)
       GROUP BY notice.url, group_link.jid
       ORDER BY notice.first_seen, notice.url`, // oldest first, one row per (notice, group)
    )
    .all(freshnessCutoff, freshnessCutoff, includeWaitingForBody ? 1 : 0, isoAgo(36e5)); // wait for the body, but at most 1 hour
}

// Mark a notice as sent (or failed, skipped, duplicate) for one group.
export const recordDelivery = (db, url, jid, status) =>
  db.prepare('INSERT OR REPLACE INTO deliveries (url, jid, status, at) VALUES (?, ?, ?, ?)').run(url, jid, status, nowIso()); // idempotent

// Drop every queued message (also the ones waiting for their body); returns how many were dropped.
export function cancelPendingDeliveries(db) {
  const queued = pendingDeliveries(db, 3, true); // whole queue
  for (const delivery of queued) recordDelivery(db, delivery.url, delivery.jid, 'skipped'); // out of the queue for good
  return queued.length;
}

// Same title (case and spaces ignored) and same attachment links = the same notice published twice.
const noticeIdentity = (notice) =>
  `${notice.title.toLowerCase().replace(/\s+/g, ' ').trim()}|${JSON.parse(notice.attachments)
    .map((attachment) => attachment.url)
    .sort()
    .join(' ')}`;

// True when the group already received, in the last 3 days, a notice identical to this one under another URL.
export function wasIdenticalNoticeSent(db, url, jid) {
  const candidate = db.prepare('SELECT title, attachments FROM notices WHERE url = ?').get(url); // notice about to be sent
  return db
    .prepare(
      "SELECT notice.title, notice.attachments FROM deliveries delivery JOIN notices notice ON notice.url = delivery.url WHERE delivery.jid = ? AND delivery.status = 'sent' AND delivery.at >= ? AND delivery.url != ?",
    )
    .all(jid, isoAgo(3 * 864e5), url) // same window as the queue
    .some((sentNotice) => noticeIdentity(sentNotice) === noticeIdentity(candidate)); // different attachment numbers = different notices
}

// Number of messages sent in the last hour (rate limiting).
export const countSentLastHour = (db) => db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE status = 'sent' AND at >= ?").get(isoAgo(36e5)).total; // rolling window

// Number of deliveries given up in the last 24 hours (broken group links).
export const countFailedLastDay = (db) => db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE status = 'failed' AND at >= ?").get(isoAgo(864e5)).total; // rolling window

// True when a notice URL is already stored.
export const isNoticeKnown = (db, url) => Boolean(db.prepare('SELECT 1 FROM notices WHERE url = ?').get(url)); // dedup check

// Read one notice with its attachments parsed.
export function getNotice(db, url) {
  const row = db.prepare('SELECT * FROM notices WHERE url = ?').get(url); // single row
  return row && { ...row, attachments: JSON.parse(row.attachments) }; // decode JSON column
}

// Latest notices for a target (or all targets when targetId is null), newest first.
export const latestNotices = (db, targetId, limit = 50) =>
  (targetId
    ? db
        .prepare(
          'SELECT notice.* FROM notices notice JOIN notice_targets notice_target ON notice_target.url = notice.url WHERE notice_target.target = ? ORDER BY COALESCE(notice.published, notice.first_seen) DESC LIMIT ?',
        )
        .all(targetId, limit) // one target
    : db.prepare('SELECT * FROM notices ORDER BY COALESCE(published, first_seen) DESC LIMIT ?').all(limit)
  ) // everything
    .map((row) => ({ ...row, attachments: JSON.parse(row.attachments) })); // decode JSON column

// Queue the newest notice of each linked target (or of one target) for its groups; returns how many were queued.
export function queueLatestNoticePerGroup(db, onlyTargetId) {
  const insertManualSend = db.prepare(
    'INSERT OR IGNORE INTO manual_sends (url, jid, at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE url = ? AND jid = ?)',
  ); // skip already delivered
  let queuedCount = 0; // counter
  for (const groupLink of listGroupLinks(db))
    if (!onlyTargetId || groupLink.target === onlyTargetId) {
      const [newestNotice] = latestNotices(db, groupLink.target, 1); // newest notice of this target
      if (newestNotice) queuedCount += Number(insertManualSend.run(newestNotice.url, groupLink.jid, nowIso(), newestNotice.url, groupLink.jid).changes); // one per (notice, group)
    }
  return queuedCount;
}

// Link a WhatsApp group to a target.
export const linkGroup = (db, targetId, jid) =>
  db.prepare('INSERT OR IGNORE INTO group_map (target, jid, created_at) VALUES (?, ?, ?)').run(targetId, jid, nowIso()); // idempotent
// Remove a group link; returns the number of rows removed.
export const unlinkGroup = (db, targetId, jid) => db.prepare('DELETE FROM group_map WHERE target = ? AND jid = ?').run(targetId, jid).changes;
// All current group links.
export const listGroupLinks = (db) => db.prepare('SELECT target, jid FROM group_map ORDER BY target').all(); // for !mappa

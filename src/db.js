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
      url TEXT NOT NULL,                      -- notice URL, or "<URL>#aggiornamento-<time>" for the update of a page
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
    CREATE TABLE IF NOT EXISTS notice_updates (
      url TEXT NOT NULL,                      -- page the site changed, under the same URL
      target TEXT NOT NULL,                   -- board listing the page today (not notice_targets: it keeps the courses of the old school fan-out)
      at TEXT NOT NULL,                       -- when the bot noticed, the same for all the targets of one update
      PRIMARY KEY (url, target, at)
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT); -- small state: seeded sources, feed order, last poll, pause flag
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
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, updated = COALESCE(MAX(excluded.updated, notices.updated), excluded.updated, notices.updated)`, // keep body/notify, refresh title, the date only moves forward (two boards may disagree)
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
  const newNotices = db
    .prepare(
      `SELECT notice.url, group_link.jid, MIN(group_link.target) AS target, notice.url AS deliveryKey, 0 AS isUpdate, notice.first_seen AS queuedAt
       FROM notices notice
       JOIN notice_targets notice_target ON notice_target.url = notice.url
       JOIN group_map group_link ON group_link.target = notice_target.target
       LEFT JOIN deliveries delivery ON delivery.url = notice.url AND delivery.jid = group_link.jid
       LEFT JOIN manual_sends manual ON manual.url = notice.url AND manual.jid = group_link.jid
       WHERE delivery.url IS NULL
         AND ((notice.notify = 1 AND notice.first_seen >= group_link.created_at AND notice.first_seen >= ?) OR manual.at >= ?)
         AND (? OR notice.body IS NOT NULL OR COALESCE(manual.at, notice.first_seen) < ?)
       GROUP BY notice.url, group_link.jid`, // one row per (notice, group)
    )
    .all(freshnessCutoff, freshnessCutoff, includeWaitingForBody ? 1 : 0, isoAgo(36e5)); // wait for the body, but at most 1 hour
  const pageUpdates = db
    .prepare(
      `SELECT page_update.url, group_link.jid, MIN(group_link.target) AS target, page_update.deliveryKey, 1 AS isUpdate, page_update.at AS queuedAt
       FROM (SELECT *, url || '#aggiornamento-' || at AS deliveryKey FROM notice_updates) page_update
       JOIN group_map group_link ON group_link.target = page_update.target
       LEFT JOIN deliveries delivery ON delivery.url = page_update.deliveryKey AND delivery.jid = group_link.jid
       WHERE delivery.url IS NULL AND page_update.at >= ? AND page_update.at >= group_link.created_at
       GROUP BY page_update.deliveryKey, group_link.jid`, // one row per (update, group); the body was refreshed before the update was recorded
    )
    .all(freshnessCutoff); // same limit as new notices: no floods after downtime
  return [...newNotices, ...pageUpdates].sort(
    (left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.deliveryKey.localeCompare(right.deliveryKey),
  ); // oldest first
}

// Updates announced per page in any 24 hours (decided by the owner on 2026-11-04).
const MAX_UPDATES_PER_DAY = 2;
// Quiet time after an update and after the first sighting: authors save several times, and one edit can show in two feeds or two boards.
const UPDATE_QUIET_MS = 36e5;

// Record that a page changed under the same URL, for the boards listing it; returns false when it must stay silent (just published, just announced, or daily cap reached).
export function recordNoticeUpdate(db, url, targetIds) {
  if (db.prepare('SELECT 1 FROM notices WHERE url = ? AND first_seen > ?').get(url, isoAgo(UPDATE_QUIET_MS))) return false; // a fix right after publishing: the first message is enough
  const lastDay = db.prepare('SELECT DISTINCT at FROM notice_updates WHERE url = ? AND at >= ?').all(url, isoAgo(864e5)); // recent updates of this page
  if (lastDay.length >= MAX_UPDATES_PER_DAY || lastDay.some(({ at }) => at > isoAgo(UPDATE_QUIET_MS))) return false; // daily cap or quiet time
  const noticedAt = nowIso(); // one time: one message per group, even with two of its targets
  for (const targetId of targetIds) db.prepare('INSERT INTO notice_updates (url, target, at) VALUES (?, ?, ?)').run(url, targetId, noticedAt); // queued for the groups of these boards
  return true; // announced
}

// Mark a notice as sent (or failed, skipped, duplicate) for one group.
export const recordDelivery = (db, url, jid, status) =>
  db.prepare('INSERT OR REPLACE INTO deliveries (url, jid, status, at) VALUES (?, ?, ?, ?)').run(url, jid, status, nowIso()); // idempotent

// Drop every queued message (also the ones waiting for their body); returns how many were dropped.
export function cancelPendingDeliveries(db) {
  const queued = pendingDeliveries(db, 3, true); // whole queue
  for (const delivery of queued) recordDelivery(db, delivery.deliveryKey, delivery.jid, 'skipped'); // out of the queue for good
  return queued.length;
}

// Same title (case and spaces ignored) and same attachment links = the same notice published twice.
const noticeIdentity = (notice) =>
  `${notice.title.toLowerCase().replace(/\s+/g, ' ').trim()}|${JSON.parse(notice.attachments)
    .map((attachment) => attachment.url)
    .sort()
    .join(' ')}`;

// A notice as stored (attachments still JSON).
const storedNotice = (db, url) => db.prepare('SELECT * FROM notices WHERE url = ?').get(url);
// Notices really sent to a group under another URL, with the time of the send.
const noticesSentElsewhere = (db, url, jid) =>
  db
    .prepare(
      "SELECT notice.*, delivery.at AS sent_at FROM deliveries delivery JOIN notices notice ON notice.url = delivery.url WHERE delivery.jid = ? AND delivery.status = 'sent' AND delivery.url != ?",
    )
    .all(jid, url);

// True when the group already received, in the last 3 days, a notice identical to this one under another URL.
export function wasIdenticalNoticeSent(db, url, jid) {
  const candidateIdentity = noticeIdentity(storedNotice(db, url)); // notice about to be sent
  const windowStart = isoAgo(3 * 864e5); // same window as the queue
  return noticesSentElsewhere(db, url, jid).some((sentNotice) => sentNotice.sent_at >= windowStart && noticeIdentity(sentNotice) === candidateIdentity); // different attachment numbers = different notices
}

// The words of a text: links and spaces are ignored, because the sites paste the new attachment's link inside the text and sometimes lose a space after it.
const withoutLinks = (text) => String(text ?? '').replace(/https?:\/\/[^\s)]+/g, ''); // links
const wordsOf = (text) => withoutLinks(text).replace(/\s+/g, ''); // spaces and line breaks

// Changed words from this many up are worth a message; fewer are a typo fix (decided by the owner on 2026-11-04).
const MIN_CHANGED_WORDS = 5;

// How many words differ between two texts, in any position: a replaced word counts once.
function countChangedWords(before, after) {
  const remaining = new Map(); // word -> how many of it the old text still has unmatched
  for (const word of withoutLinks(before).split(/\s+/).filter(Boolean)) remaining.set(word, (remaining.get(word) ?? 0) + 1);
  let added = 0; // words of the new text the old one does not have
  for (const word of withoutLinks(after).split(/\s+/).filter(Boolean)) {
    if (remaining.get(word) > 0) remaining.set(word, remaining.get(word) - 1);
    else added++;
  }
  const removed = [...remaining.values()].reduce((total, count) => total + count, 0); // words of the old text gone
  return Math.max(added, removed);
}

// True when an edit deserves a message: a new file or enough changed words. With no stored text there is nothing to compare, so the group is told.
export function isWorthAnnouncing(before, after) {
  if (before.body == null) return true; // never read: it may hold anything
  const knownFiles = new Set(before.attachments.map((attachment) => attachment.url)); // files the bot already knew
  if (after.attachments.some((attachment) => !knownFiles.has(attachment.url))) return true; // e.g. a new scorrimento
  return countChangedWords(`${before.title} ${before.body}`, `${after.title} ${after.body}`) >= MIN_CHANGED_WORDS; // a typo fix stays silent
}

// True when the group already received an earlier notice with the same words under another URL: this one is its update (e.g. new files). No time limit.
export function wasSameTextSent(db, url, jid) {
  const candidate = storedNotice(db, url); // notice about to be sent
  return noticesSentElsewhere(db, url, jid).some(
    (sentNotice) =>
      sentNotice.first_seen <= candidate.first_seen && // an older notice sent late (retry, !prova) is not the update of a newer one
      wordsOf(sentNotice.title) === wordsOf(candidate.title) && // title and body compared separately
      wordsOf(sentNotice.body) === wordsOf(candidate.body),
  );
}

// Number of messages sent in the last hour (rate limiting).
export const countSentLastHour = (db) => db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE status = 'sent' AND at >= ?").get(isoAgo(36e5)).total; // rolling window

// Number of deliveries given up in the last 24 hours (broken group links).
export const countFailedLastDay = (db) => db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE status = 'failed' AND at >= ?").get(isoAgo(864e5)).total; // rolling window

// True when a notice URL is already stored.
export const isNoticeKnown = (db, url) => Boolean(db.prepare('SELECT 1 FROM notices WHERE url = ?').get(url)); // dedup check

// Read one notice with its attachments parsed.
export function getNotice(db, url) {
  const row = storedNotice(db, url); // single row
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

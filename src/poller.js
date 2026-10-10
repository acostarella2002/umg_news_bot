// One polling cycle: read every notice board, store new notices, fetch details of the ones to send.
import { fetchText as defaultFetch } from './http.js'; // allowlisted fetcher
import { parseList, parseRss, parseDetail } from './parse.js'; // parsers
import { upsertNotices, noticesNeedingDetail, saveDetail, getKv, setKv, isKnown } from './db.js'; // storage

// More "new" notices than this in one read of a board may be a re-listing (site moved, URLs changed), not real news.
const MAX_NEW_PER_BOARD = 10;
// In that case only notices published in the last 3 days are queued (same window as pendingDeliveries).
const RECENT_MS = 3 * 864e5;

// Build the job list: what to fetch, how to parse it and which targets the notices belong to.
export function buildJobs(sources) {
  const coursesOf = (school) => sources.courses.filter((c) => c.school === school).map((c) => c.id); // course ids of a school
  return [
    ...sources.courses.map((c) => ({ url: c.url, targets: [c.id], parse: (h) => parseList(h, c.url) })), // course boards
    ...sources.schools.map((s) => ({ url: s.url, targets: [s.id, ...coursesOf(s.id)], parse: (h) => parseList(h, s.url, ['avviso']) })), // school notices fan out to its courses
    ...sources.feeds.map((f) => ({ url: f.url, targets: [f.id], parse: parseRss })), // ateneo / fondazione RSS
  ];
}

// Run async tasks with a fixed concurrency (polite to the university servers).
async function pool(items, size, fn) {
  const queue = [...items]; // shared work queue
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) await fn(queue.shift()); // each worker takes the next job until none is left
    }),
  ); // N workers drain it
}

// Execute one full cycle; returns a small summary for logging.
export async function pollOnce({ db, sources, fetchText = defaultFetch, log = console, detailLimit = 20 }) {
  const summary = { sources: 0, errors: 0, added: 0, details: 0 }; // counters
  await pool(buildJobs(sources), 3, async (job) => {
    try {
      const items = job.parse(await fetchText(job.url)); // download + parse the board
      const seedKey = `seeded:${job.url}`; // first successful read of this board?
      const seeded = getKv(db, seedKey) !== null; // after the first read, everything new is notified
      const fresh = items.filter((n) => !isKnown(db, n.url)).length; // URLs never seen before
      const burst = seeded && fresh > MAX_NEW_PER_BOARD; // many at once: tell real news from re-listed old notices by date
      const recent = (n) => !burst || Date.parse(n.published) >= Date.now() - RECENT_MS; // no date counts as old
      const queued = items.filter(recent); // notified (the sender slows down on a long queue)
      if (burst)
        log.warn?.(
          { url: job.url, err: `${fresh} new notices at once: ${queued.length} recent ones queued, the rest stored without notifying` },
          'source burst',
        ); // public URL only
      summary.added += upsertNotices(db, job.targets, queued, seeded); // store (notify only when already seeded)
      summary.added += upsertNotices(
        db,
        job.targets,
        items.filter((n) => !recent(n)),
        false,
      ); // old re-listed notices: RSS only
      if (!seeded && items.length) setKv(db, seedKey, new Date().toISOString()); // an empty first read (maintenance page, broken layout) is not a seed
      summary.sources++; // success
    } catch (err) {
      summary.errors++; // one broken board never stops the others
      log.warn?.({ url: job.url, err: err.message }, 'source failed'); // public URL only, no user data
    }
  });
  for (const { url } of noticesNeedingDetail(db, detailLimit)) {
    try {
      saveDetail(db, url, parseDetail(await fetchText(url), url)); // body + attachments
      summary.details++; // success
    } catch (err) {
      saveDetail(db, url, { body: '', attachments: [] }); // give up on the body: send title + link instead of retrying forever
      log.warn?.({ url, err: err.message }, 'detail failed'); // public URL only
    }
  }
  setKv(db, 'last_poll', new Date().toISOString()); // for !stato and /health
  return summary; // e.g. { sources: 50, errors: 0, added: 2, details: 2 }
}

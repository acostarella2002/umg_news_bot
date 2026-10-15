// One polling cycle: read every notice board, store new notices, fetch details of the ones to send.
import { fetchText as defaultFetchText } from './http.js'; // allowlisted fetcher
import { parseList, parseRss, parseDetail } from './parse.js'; // parsers
import { upsertNotices, noticesNeedingDetail, saveDetail, getStateValue, setStateValue, isNoticeKnown, listGroupLinks } from './db.js'; // storage

// More "new" notices than this in one read of a board may be a re-listing (site moved, URLs changed), not real news.
const MAX_NEW_PER_BOARD = 10;
// In that case only notices published in the last 3 days are queued (same window as pendingDeliveries).
const RECENT_WINDOW_MS = 3 * 864e5;
// Boards read at the same time (polite to the university servers).
const CONCURRENT_FETCHES = 3;

// Build the job list: what to fetch, how to parse it and which targets the notices belong to.
// schoolHasGroup(id): true when that school has its own WhatsApp group; then its notices are not fanned out to the courses.
export function buildJobs(sources, schoolHasGroup = () => false) {
  const courseIdsOfSchool = (schoolId) => sources.courses.filter((course) => course.school === schoolId).map((course) => course.id); // course ids of a school
  return [
    ...sources.courses.map((course) => ({ url: course.url, targets: [course.id], parse: (html) => parseList(html, course.url) })), // course boards
    ...sources.schools.map((school) => ({
      url: school.url,
      targets: [school.id, ...(schoolHasGroup(school.id) ? [] : courseIdsOfSchool(school.id))], // fan out to the courses only while the school has no group
      parse: (html) => parseList(html, school.url, ['avviso']),
    })),
    ...sources.feeds.map((feed) => ({ url: feed.url, targets: [feed.id], parse: parseRss })), // ateneo / fondazione RSS
  ];
}

// Run async tasks with a fixed concurrency.
async function runWithConcurrency(tasks, concurrency, runTask) {
  const remaining = [...tasks]; // shared work queue
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (remaining.length) await runTask(remaining.shift()); // each worker takes the next task until none is left
    }),
  ); // N workers drain it
}

// Execute one full cycle; returns a small summary for logging.
export async function pollOnce({ db, sources, fetchText = defaultFetchText, log = console, detailLimit = 20 }) {
  const summary = { sources: 0, errors: 0, added: 0, details: 0 }; // counters
  const targetsWithGroup = new Set(listGroupLinks(db).map((groupLink) => groupLink.target)); // targets with a WhatsApp group right now
  await runWithConcurrency(
    buildJobs(sources, (targetId) => targetsWithGroup.has(targetId)),
    CONCURRENT_FETCHES,
    async (job) => {
      try {
        const notices = job.parse(await fetchText(job.url)); // download + parse the board
        const seedKey = `seeded:${job.url}`; // first successful read of this board?
        const isSeeded = getStateValue(db, seedKey) !== null; // after the first read, everything new is notified
        const unseenCount = notices.filter((notice) => !isNoticeKnown(db, notice.url)).length; // URLs never seen before
        const isBurst = isSeeded && unseenCount > MAX_NEW_PER_BOARD; // many at once: tell real news from re-listed old notices by date
        const isRecent = (notice) => !isBurst || Date.parse(notice.published) >= Date.now() - RECENT_WINDOW_MS; // no date counts as old
        const toNotify = notices.filter(isRecent); // notified (the sender slows down on a long queue)
        if (isBurst)
          log.warn?.(
            { url: job.url, err: `${unseenCount} new notices at once: ${toNotify.length} recent ones queued, the rest stored without notifying` },
            'source burst',
          ); // public URL only
        summary.added += upsertNotices(db, job.targets, toNotify, isSeeded); // store (notify only when already seeded)
        summary.added += upsertNotices(
          db,
          job.targets,
          notices.filter((notice) => !isRecent(notice)),
          false,
        ); // old re-listed notices: RSS only
        if (!isSeeded && notices.length) setStateValue(db, seedKey, new Date().toISOString()); // an empty first read (maintenance page, broken layout) is not a seed
        summary.sources++; // success
      } catch (err) {
        summary.errors++; // one broken board never stops the others
        log.warn?.({ url: job.url, err: err.message }, 'source failed'); // public URL only, no user data
      }
    },
  );
  for (const { url } of noticesNeedingDetail(db, detailLimit)) {
    try {
      saveDetail(db, url, parseDetail(await fetchText(url), url)); // body + attachments
      summary.details++; // success
    } catch (err) {
      saveDetail(db, url, { body: '', attachments: [] }); // give up on the body: send title + link instead of retrying forever
      log.warn?.({ url, err: err.message }, 'detail failed'); // public URL only
    }
  }
  setStateValue(db, 'last_poll', new Date().toISOString()); // for !stato and /health
  return summary; // e.g. { sources: 50, errors: 0, added: 2, details: 2 }
}

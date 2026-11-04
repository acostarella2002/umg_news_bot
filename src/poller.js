// One polling cycle: read every notice board, store new notices, fetch details of the ones to send.
import { fetchText as defaultFetchText } from './http.js'; // allowlisted fetcher
import { parseList, parseRss, parseDetail } from './parse.js'; // parsers
import {
  upsertNotices,
  noticesNeedingDetail,
  saveDetail,
  getStateValue,
  setStateValue,
  isNoticeKnown,
  listGroupLinks,
  getNotice,
  recordNoticeUpdate,
  isWorthAnnouncing,
} from './db.js'; // storage

// More new or edited notices than this in one read of a board may be a re-listing (site moved, URLs changed, list re-sorted), not real news.
const MAX_NEW_PER_BOARD = 10;
// In that case only notices published in the last 3 days are queued (same window as pendingDeliveries).
const RECENT_WINDOW_MS = 3 * 864e5;
// Boards read at the same time (polite to the university servers).
const CONCURRENT_FETCHES = 3;
// How much of a feed is remembered to notice pages moving up; the Ateneo feeds have 50 items at most, Fondazione over 400.
const FEED_ORDER_LENGTH = 50;

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
    ...sources.feeds.map((feed) => ({ url: feed.url, targets: [feed.id], parse: parseRss, isFeed: true })), // ateneo / fondazione RSS
  ];
}

// Pages that moved up since the previous read of a list, compared by code only. The longest chain still in the old order did not move;
// what sits above its last page and is not part of it did. A new page pushing the others down, or a page sinking, moves nothing up.
export function findMovedUp(previousOrder, currentOrder) {
  const previousRank = new Map(previousOrder.map((url, rank) => [url, rank])); // old position of each page
  const common = currentOrder.filter((url) => previousRank.has(url)); // pages present in both reads, in the new order
  const chainFrom = common.map(() => 1); // longest chain in the old order starting at each page
  for (let index = common.length - 1; index >= 0; index--)
    for (let below = index + 1; below < common.length; below++)
      if (previousRank.get(common[below]) > previousRank.get(common[index])) chainFrom[index] = Math.max(chainFrom[index], chainFrom[below] + 1); // extends a chain
  const stayed = []; // pages that kept their place
  for (let needed = Math.max(0, ...chainFrom); needed > 0; needed--) {
    const lastRank = stayed.length ? previousRank.get(stayed.at(-1)) : -1; // the chain continues below this old position
    stayed.push(common.findLast((url, index) => chainFrom[index] === needed && previousRank.get(url) > lastRank)); // on a tie the lower page stayed: A B -> B A means B moved up
  }
  return currentOrder.slice(0, currentOrder.indexOf(stayed.at(-1)) + 1).filter((url) => !stayed.includes(url)); // above the last page that stayed; nothing when no page is common
}

// Stored pages the site changed since the last read: a later "updated" date on the boards, a higher place in the feeds (they have no such date).
const findEditedNotices = (db, notices, movedUp) =>
  notices.filter((notice) => {
    const stored = getNotice(db, notice.url); // what we know about this code
    return stored && (movedUp.includes(notice.url) || (stored.updated && notice.updated > stored.updated)); // a page never seen is a new notice, not an update
  });

// Store the page as it is now, so the message shows it; returns false when it could not be read and the old text stays.
async function refreshEditedNotice({ db, notice, fetchText, log }) {
  try {
    saveDetail(db, notice.url, notice.body == null ? parseDetail(await fetchText(notice.url), notice.url) : notice); // only some feeds carry the whole text
    return true; // read
  } catch (err) {
    log.warn?.({ url: notice.url, err: err.message }, 'detail failed'); // public URL only
    return false; // what changed stays unknown
  }
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
  const summary = { sources: 0, errors: 0, added: 0, details: 0, updates: 0 }; // counters
  const targetsWithGroup = new Set(listGroupLinks(db).map((groupLink) => groupLink.target)); // targets with a WhatsApp group right now
  const editedPages = new Map(); // URL -> { before: the stored notice, targets: every board listing the page in this cycle, isUnread: the page could not be read }
  await runWithConcurrency(
    buildJobs(sources, (targetId) => targetsWithGroup.has(targetId)),
    CONCURRENT_FETCHES,
    async (job) => {
      try {
        const notices = job.parse(await fetchText(job.url)); // download + parse the board
        const seedKey = `seeded:${job.url}`; // first successful read of this board?
        const isSeeded = getStateValue(db, seedKey) !== null; // after the first read, everything new is notified
        const orderKey = `order:${job.url}`; // what this feed looked like at the last read
        const currentOrder = notices.slice(0, FEED_ORDER_LENGTH).map((notice) => notice.url); // top of the list, by code
        const movedUp = job.isFeed ? findMovedUp(JSON.parse(getStateValue(db, orderKey) ?? '[]'), currentOrder) : []; // only feeds show edits by their order
        const editedNotices = findEditedNotices(db, notices, movedUp); // read before the upsert moves the stored dates
        const isEditBurst = editedNotices.length > MAX_NEW_PER_BOARD; // a re-sorted site must not flood the groups
        if (isEditBurst)
          log.warn?.({ url: job.url, err: `${editedNotices.length} pages changed at once: no update sent` }, 'source burst'); // public URL only
        else
          for (const notice of editedNotices)
            if (!editedPages.has(notice.url)) editedPages.set(notice.url, { before: getNotice(db, notice.url), targets: new Set(), isUnread: false }); // first board to notice in this cycle
        for (const notice of notices) for (const target of job.targets) editedPages.get(notice.url)?.targets.add(target); // also the boards reading the page after the stored date moved
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
        if (job.isFeed && notices.length) setStateValue(db, orderKey, JSON.stringify(currentOrder)); // an empty read keeps the old order
        if (!isEditBurst)
          for (const notice of editedNotices) {
            const isRead = await refreshEditedNotice({ db, notice, fetchText, log }); // last: this wait lets the other boards run
            if (!isRead) editedPages.get(notice.url).isUnread = true; // the group is still told to look at the page
          }
        summary.sources++; // success
      } catch (err) {
        summary.errors++; // one broken board never stops the others
        log.warn?.({ url: job.url, err: err.message }, 'source failed'); // public URL only, no user data
      }
    },
  );
  for (const [url, { before, targets, isUnread }] of editedPages)
    if (!isUnread && !isWorthAnnouncing(before, getNotice(db, url)))
      log.info?.({ url }, 'small page edit not announced'); // the text is already fresh, the daily cap is not touched; public URL only
    else if (recordNoticeUpdate(db, url, [...targets])) {
      summary.updates++; // queued for the groups
      log.info?.({ url }, 'page update queued'); // public URL only
    }
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

// Live check of every configured source: prints notice count and newest date, flags failures.
import { sources } from '../src/config.js'; // configured sources
import { fetchText } from '../src/http.js'; // allowlisted fetcher
import { parseList, parseRss } from '../src/parse.js'; // parsers

// Build one flat list of [label, url, parser] entries.
const checks = [
  ...sources.courses.map((course) => [`corso:${course.id}`, course.url, (html) => parseList(html, course.url)]), // course pages
  ...sources.schools.map((school) => [`scuola:${school.id}`, school.url, (html) => parseList(html, school.url, ['avviso'])]), // school pages
  ...sources.feeds.map((feed) => [`feed:${feed.name}`, feed.url, parseRss]), // RSS feeds
];

let failedCount = 0; // number of broken sources
for (const [label, url, parse] of checks) {
  try {
    const notices = parse(await fetchText(url)); // fetch + parse
    const newestDate =
      notices
        .map((notice) => notice.published)
        .filter(Boolean)
        .sort()
        .at(-1) ?? '-'; // most recent date
    const emptyFlag = notices.length === 0 ? '  <-- EMPTY' : ''; // an empty board is suspicious
    if (!notices.length) failedCount++; // count it as a failure
    console.log(`${label.padEnd(48)} ${String(notices.length).padStart(5)}  ${newestDate.slice(0, 10)}${emptyFlag}`); // one line per source
  } catch (err) {
    failedCount++; // count network/HTTP errors
    console.log(`${label.padEnd(48)} ERROR ${err.message}`); // show the reason
  }
}
process.exitCode = failedCount ? 1 : 0; // non-zero exit when something is broken

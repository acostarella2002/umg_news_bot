// Live check of every configured source: prints notice count and newest date, flags failures.
import { sources } from '../src/config.js'; // configured sources
import { fetchText } from '../src/http.js'; // allowlisted fetcher
import { buildJobs } from '../src/poller.js'; // same jobs and parsers as the real polling

let failedCount = 0; // number of broken sources
for (const { url, targets, parse } of buildJobs(sources)) {
  const label = targets[0].padEnd(24); // the board id; several feeds share one id, so each line also shows its URL
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
    console.log(`${label} ${String(notices.length).padStart(5)}  ${newestDate.slice(0, 10).padEnd(10)}  ${url}${emptyFlag}`); // one line per source
  } catch (err) {
    failedCount++; // count network/HTTP errors
    console.log(`${label} ERROR ${err.message}  ${url}`); // show the reason
  }
}
process.exitCode = failedCount ? 1 : 0; // non-zero exit when something is broken

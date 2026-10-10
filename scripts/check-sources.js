// Live check of every configured source: prints notice count and newest date, flags failures.
import { sources } from '../src/config.js'; // configured sources
import { fetchText } from '../src/http.js'; // allowlisted fetcher
import { parseList, parseRss } from '../src/parse.js'; // parsers

// Build one flat list of [label, url, parser] entries.
const jobs = [
  ...sources.courses.map((c) => [`corso:${c.id}`, c.url, (h) => parseList(h, c.url)]), // course pages
  ...sources.schools.map((s) => [`scuola:${s.id}`, s.url, (h) => parseList(h, s.url, ['avviso'])]), // school pages
  ...sources.feeds.map((f) => [`feed:${f.name}`, f.url, parseRss]), // RSS feeds
];

let failed = 0; // number of broken sources
for (const [label, url, parse] of jobs) {
  try {
    const items = parse(await fetchText(url)); // fetch + parse
    const newest =
      items
        .map((i) => i.published)
        .filter(Boolean)
        .sort()
        .at(-1) ?? '-'; // most recent date
    const flag = items.length === 0 ? '  <-- EMPTY' : ''; // an empty board is suspicious
    if (!items.length) failed++; // count it as a failure
    console.log(`${label.padEnd(48)} ${String(items.length).padStart(5)}  ${newest.slice(0, 10)}${flag}`); // one line per source
  } catch (err) {
    failed++; // count network/HTTP errors
    console.log(`${label.padEnd(48)} ERROR ${err.message}`); // show the reason
  }
}
process.exitCode = failed ? 1 : 0; // non-zero exit when something is broken

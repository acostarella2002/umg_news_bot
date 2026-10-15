// Read-only HTTP server exposing the RSS feeds. No write endpoints, no user data.
import { createServer } from 'node:http'; // stdlib HTTP server
import { accessSync, constants } from 'node:fs'; // data folder check
import { buildRss } from './rss.js'; // feed renderer
import { latestNotices, getStateValue } from './db.js'; // storage

// Security headers sent with every response.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', // no MIME sniffing
  'content-security-policy': "default-src 'none'", // nothing executable ever
  'referrer-policy': 'no-referrer', // do not leak URLs
  'x-frame-options': 'DENY', // no framing
};

// List every feed the server knows: all + courses + schools + feeds (deduplicated ids).
export function feedList(sources) {
  const feeds = [{ id: 'all', name: 'UMG - Tutti gli avvisi' }]; // aggregated feed
  for (const source of [...sources.courses, ...sources.schools, ...sources.feeds])
    // every configured source
    if (!feeds.some((feed) => feed.id === source.id)) feeds.push({ id: source.id, name: source.name.replace(/ - .*$/, '') }); // "Ateneo UMG - X" -> "Ateneo UMG"
  return feeds; // [{ id, name }]
}

// Health summary for /health and the Docker HEALTHCHECK; ok = false means a human must look at it.
export function computeHealth({ db, dataDir, pollMinutes, startedAt, whatsapp, now = Date.now() }) {
  let dataWritable = true; // the data folder holds the DB and the WhatsApp session
  try {
    accessSync(dataDir, constants.W_OK); // permissions changed, volume missing…
  } catch {
    dataWritable = false;
  }
  const lastPoll = getStateValue(db, 'last_poll'); // written at the end of every cycle
  const pollsRunning = now - Date.parse(lastPoll ?? startedAt) < 3 * pollMinutes * 60_000; // three missed cycles = stuck (e.g. disk full)
  const ok = dataWritable && pollsRunning && !['logged_out', 'replaced'].includes(whatsapp); // these need a human, a restart cannot fix them
  return { ok, lastPoll, dataWritable, pollsRunning, whatsapp };
}

// Build the HTTP server (not started; caller calls .listen()).
export function createRssServer({ db, sources, baseUrl, health = () => ({ ok: true, lastPoll: getStateValue(db, 'last_poll') }) }) {
  const feedsById = new Map(feedList(sources).map((feed) => [feed.id, feed])); // id -> feed, also the route whitelist
  return createServer((request, response) => {
    // Send a response with the security headers.
    const send = (statusCode, contentType, body) => {
      response.writeHead(statusCode, {
        ...SECURITY_HEADERS,
        'content-type': contentType,
        'cache-control': statusCode === 200 ? 'public, max-age=300' : 'no-store',
      }); // 5-minute cache
      response.end(request.method === 'HEAD' ? undefined : body); // HEAD gets headers only
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'text/plain', 'Method Not Allowed'); // read-only server
    const path = new URL(request.url, 'http://x').pathname; // ignore query string
    if (path === '/health') {
      const status = health(); // current status
      return send(status.ok ? 200 : 503, 'application/json', JSON.stringify(status)); // 503 marks the container "unhealthy"
    }
    if (path === '/feeds' || path === '/')
      // index of available feeds
      return send(
        200,
        'application/json; charset=utf-8',
        JSON.stringify(
          [...feedsById.values()].map((feed) => ({ ...feed, rss: `${baseUrl}/rss/${feed.id}.xml` })),
          null,
          2,
        ),
      );
    const feedMatch = /^\/rss\/([a-z0-9_]+)\.xml$/.exec(path); // strict id pattern: no traversal, no odd chars
    const feed = feedMatch && feedsById.get(feedMatch[1]); // must be a known feed id
    if (!feed) return send(404, 'text/plain', 'Not Found'); // anything else
    const items = latestNotices(db, feed.id === 'all' ? null : feed.id, 50); // newest 50
    return send(200, 'application/rss+xml; charset=utf-8', buildRss({ title: feed.name, link: baseUrl, selfUrl: `${baseUrl}${path}`, items })); // render
  });
}

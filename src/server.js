// Read-only HTTP server exposing the RSS feeds. No write endpoints, no user data.
import { createServer } from 'node:http'; // stdlib HTTP server
import { accessSync, constants } from 'node:fs'; // data folder check
import { buildRss } from './rss.js'; // feed renderer
import { latestNotices, getKv } from './db.js'; // storage

// Security headers sent with every response.
const HEADERS = {
  'x-content-type-options': 'nosniff', // no MIME sniffing
  'content-security-policy': "default-src 'none'", // nothing executable ever
  'referrer-policy': 'no-referrer', // do not leak URLs
  'x-frame-options': 'DENY', // no framing
};

// List every feed the server knows: all + courses + schools + feeds (deduplicated ids).
export function feedList(sources) {
  const list = [{ id: 'all', name: 'UMG - Tutti gli avvisi' }]; // aggregated feed
  for (const s of [...sources.courses, ...sources.schools, ...sources.feeds])
    // every configured source
    if (!list.some((f) => f.id === s.id)) list.push({ id: s.id, name: s.name.replace(/ - .*$/, '') }); // "Ateneo UMG - X" -> "Ateneo UMG"
  return list; // [{ id, name }]
}

// Health summary for /health and the Docker HEALTHCHECK; ok = false means a human must look at it.
export function healthOf({ db, dataDir, pollMinutes, startedAt, whatsapp, now = Date.now() }) {
  let dataWritable = true; // the data folder holds the DB and the WhatsApp session
  try {
    accessSync(dataDir, constants.W_OK); // permissions changed, volume missing…
  } catch {
    dataWritable = false;
  }
  const lastPoll = getKv(db, 'last_poll'); // written at the end of every cycle
  const pollsRunning = now - Date.parse(lastPoll ?? startedAt) < 3 * pollMinutes * 60_000; // three missed cycles = stuck (e.g. disk full)
  const ok = dataWritable && pollsRunning && !['logged_out', 'replaced'].includes(whatsapp); // these need a human, a restart cannot fix them
  return { ok, lastPoll, dataWritable, pollsRunning, whatsapp };
}

// Build the HTTP server (not started; caller calls .listen()).
export function makeServer({ db, sources, baseUrl, health = () => ({ ok: true, lastPoll: getKv(db, 'last_poll') }) }) {
  const feeds = new Map(feedList(sources).map((f) => [f.id, f])); // id -> feed, also the route whitelist
  return createServer((req, res) => {
    // Send a response with the security headers.
    const send = (code, type, body) => {
      res.writeHead(code, { ...HEADERS, 'content-type': type, 'cache-control': code === 200 ? 'public, max-age=300' : 'no-store' }); // 5-minute cache
      res.end(req.method === 'HEAD' ? undefined : body); // HEAD gets headers only
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Method Not Allowed'); // read-only server
    const path = new URL(req.url, 'http://x').pathname; // ignore query string
    if (path === '/health') {
      const h = health(); // current status
      return send(h.ok ? 200 : 503, 'application/json', JSON.stringify(h)); // 503 marks the container "unhealthy"
    }
    if (path === '/feeds' || path === '/')
      // index of available feeds
      return send(
        200,
        'application/json; charset=utf-8',
        JSON.stringify(
          [...feeds.values()].map((f) => ({ ...f, rss: `${baseUrl}/rss/${f.id}.xml` })),
          null,
          2,
        ),
      );
    const m = /^\/rss\/([a-z0-9_]+)\.xml$/.exec(path); // strict id pattern: no traversal, no odd chars
    const feed = m && feeds.get(m[1]); // must be a known feed id
    if (!feed) return send(404, 'text/plain', 'Not Found'); // anything else
    const items = latestNotices(db, feed.id === 'all' ? null : feed.id, 50); // newest 50
    return send(200, 'application/rss+xml; charset=utf-8', buildRss({ title: feed.name, link: baseUrl, selfUrl: `${baseUrl}${path}`, items })); // render
  });
}

// Run one real polling cycle against the live sites into a throwaway in-memory DB (no WhatsApp).
import { sources } from '../src/config.js'; // configured sources
import { openDb, latestNotices } from '../src/db.js'; // storage
import { pollOnce } from '../src/poller.js'; // poller

const db = openDb(':memory:'); // nothing is written to disk
const t0 = Date.now(); // timing
console.log(await pollOnce({ db, sources, log: { warn: (o) => console.warn('WARN', o) } })); // summary counters
console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)}s`); // duration
for (const n of latestNotices(db, null, 5)) console.log(`${n.published?.slice(0, 10)}  ${n.title.slice(0, 90)}`); // 5 newest notices

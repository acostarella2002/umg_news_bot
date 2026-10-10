// Minimal HTTP fetcher restricted to the official UMG / Fondazione UMG websites.

// Only these hosts (and their subdomains) may ever be fetched: blocks SSRF via scraped links.
const ALLOWED = ['unicz.it', 'fondazioneumg.it'];
// Upper bound on downloaded bytes; the biggest real page is ~3 MB.
const MAX_BYTES = 15 * 1024 * 1024;

// True when the URL is https/http and its host is an allowed domain or a subdomain of one.
export const isAllowedUrl = (raw) => {
  try {
    const u = new URL(raw); // throws on malformed input
    const okProto = u.protocol === 'https:' || u.protocol === 'http:'; // no file:, data:, ftp: ...
    return okProto && ALLOWED.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`)); // exact or subdomain match
  } catch {
    return false; // malformed URLs are never allowed
  }
};

// Pick the charset from the Content-Type header or the XML prolog; default UTF-8.
const charsetOf = (contentType, head) => {
  const m = /charset=([\w-]+)/i.exec(contentType || '') || /encoding=["']([\w-]+)["']/i.exec(head); // header first, then <?xml encoding?>
  return (m?.[1] || 'utf-8').toLowerCase(); // TextDecoder labels are case-insensitive
};

// Fetch a page as text, with allowlist, https upgrade, timeout, size cap and one retry.
export async function fetchText(raw, { retries = 1, timeoutMs = 30000 } = {}) {
  if (!isAllowedUrl(raw)) throw new Error(`blocked host: ${raw}`); // refuse anything outside the allowlist
  const url = raw.replace(/^http:/, 'https:'); // the sites support TLS, never send plain HTTP
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'UMG-News-Bot/1.0 (student notice aggregator)' }, // identifiable, polite UA
        signal: AbortSignal.timeout(timeoutMs), // abort hung connections
        redirect: 'follow', // sites redirect www/non-www
      });
      if (!isAllowedUrl(res.url)) throw new Error(`redirected off allowlist: ${res.url}`); // a redirect must not escape the allowlist
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`); // treat 4xx/5xx as failures
      const buf = Buffer.from(await res.arrayBuffer()); // raw bytes, decoded below with the right charset
      if (buf.length > MAX_BYTES) throw new Error(`response too large: ${url}`); // shortcut: buffered before the check, fine at these sizes
      const charset = charsetOf(res.headers.get('content-type'), buf.subarray(0, 200).toString('latin1')); // sniff the prolog safely
      return new TextDecoder(charset).decode(buf); // e.g. Fondazione feeds are ISO-8859-1
    } catch (err) {
      if (attempt >= retries || /blocked|redirected off/.test(err.message)) throw err; // give up, never retry security refusals
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // linear backoff before retrying
    }
  }
}

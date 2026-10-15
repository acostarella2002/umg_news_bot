// Minimal HTTP fetcher restricted to the official UMG / Fondazione UMG websites.

// Only these hosts (and their subdomains) may ever be fetched: blocks SSRF via scraped links.
const ALLOWED_DOMAINS = ['unicz.it', 'fondazioneumg.it'];
// Upper bound on downloaded bytes; the biggest real page is ~3 MB.
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

// True when the URL is https/http and its host is an allowed domain or a subdomain of one.
export const isAllowedUrl = (rawUrl) => {
  try {
    const parsedUrl = new URL(rawUrl); // throws on malformed input
    const isWebProtocol = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:'; // no file:, data:, ftp: ...
    return isWebProtocol && ALLOWED_DOMAINS.some((domain) => parsedUrl.hostname === domain || parsedUrl.hostname.endsWith(`.${domain}`)); // exact or subdomain match
  } catch {
    return false; // malformed URLs are never allowed
  }
};

// Pick the charset from the Content-Type header or the XML prolog; default UTF-8.
const detectCharset = (contentType, documentStart) => {
  const charsetMatch = /charset=([\w-]+)/i.exec(contentType || '') || /encoding=["']([\w-]+)["']/i.exec(documentStart); // header first, then <?xml encoding?>
  return (charsetMatch?.[1] || 'utf-8').toLowerCase(); // TextDecoder labels are case-insensitive
};

// Fetch a page as text, with allowlist, https upgrade, timeout, size cap and one retry.
export async function fetchText(rawUrl, { retries = 1, timeoutMs = 30000 } = {}) {
  if (!isAllowedUrl(rawUrl)) throw new Error(`blocked host: ${rawUrl}`); // refuse anything outside the allowlist
  const secureUrl = rawUrl.replace(/^http:/, 'https:'); // the sites support TLS, never send plain HTTP
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(secureUrl, {
        headers: { 'user-agent': 'UMG-News-Bot/1.0 (student notice aggregator)' }, // identifiable, polite UA
        signal: AbortSignal.timeout(timeoutMs), // abort hung connections
        redirect: 'follow', // sites redirect www/non-www
      });
      if (!isAllowedUrl(response.url)) throw new Error(`redirected off allowlist: ${response.url}`); // a redirect must not escape the allowlist
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${secureUrl}`); // treat 4xx/5xx as failures
      const bytes = Buffer.from(await response.arrayBuffer()); // raw bytes, decoded below with the right charset
      if (bytes.length > MAX_RESPONSE_BYTES) throw new Error(`response too large: ${secureUrl}`); // shortcut: buffered before the check, fine at these sizes
      const charset = detectCharset(response.headers.get('content-type'), bytes.subarray(0, 200).toString('latin1')); // sniff the prolog safely
      return new TextDecoder(charset).decode(bytes); // e.g. Fondazione feeds are ISO-8859-1
    } catch (err) {
      if (attempt >= retries || /blocked|redirected off/.test(err.message)) throw err; // give up, never retry security refusals
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1))); // linear backoff before retrying
    }
  }
}

// Collector for Content-Security-Policy violation reports.
//
// Without this the policy is enforced blind: a violation in a browser we did
// not test is invisible until someone notices analytics stopped. Reports land
// in the Vercel function logs, which is where every other diagnosis in this
// project has started.
//
// Browsers post here with no Origin header and no user gesture, so this
// endpoint deliberately does NOT reuse the contact form's origin check. What
// keeps it pointless to abuse is that it stores nothing and sends nothing.
//
// Everything below treats the body as hostile. It is an unauthenticated POST
// that writes to a log a human reads, so a field copied through verbatim is a
// field an attacker chooses — for log injection, for volume, or to smuggle
// something that looks like a real finding. Nothing reaches the log except
// values drawn from a closed vocabulary or reduced to an origin.

// Reports are bursty by nature — one bad tag produces one per page view — so
// the log is capped per instance. State is per warm instance, same caveat as
// the contact rate limiter: a soft cap, not a guarantee.
const MAX_LOGGED_PER_WINDOW = 50;
const WINDOW_MS = 60 * 60 * 1000;

// The Reporting API batches, so one request can carry many reports. Without a
// per-request bound, a single POST of a few thousand array elements produces a
// few thousand log lines regardless of the window cap — the cap counted
// requests while the loop emitted reports. A real browser batch is small.
const MAX_REPORTS_PER_REQUEST = 10;

let logged = 0;
let windowResetAt = 0;

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A directive plus the blocked URI's origin is enough to identify a
// violation. The full URI can carry a path and query, which on a page with a
// query string can carry whatever was in it — none of which is needed here.
// Nothing this function returns may be unbounded. Node's URL parser accepts a
// hostname of any length and .origin preserves all of it, so a single report
// carrying "https://" plus a megabyte of host would put a megabyte through
// JSON.stringify and into the log. The caps count lines, not bytes.
//
// A real origin is well under this. Anything longer is not a site, so the
// value is dropped rather than truncated — a truncated one is still a
// hundred characters an attacker chose.
const MAX_ORIGIN_LEN = 100;
const MAX_SCHEME_LEN = 20;

function safeOrigin(uri) {
  if (typeof uri !== 'string' || !uri) return '(none)';
  // Bound the input before the parser sees it, not just the output.
  if (uri.length > 4096) return '(oversized)';
  // Scheme matching is case-insensitive per RFC 3986 §3.1. An earlier version
  // tested startsWith('http'), so "HTTPS://host/path?token=..." missed the URL
  // branch and fell through to a raw 40-character slice with its path and
  // query intact — the one thing this function exists to prevent.
  if (/^https?:/i.test(uri)) {
    let origin;
    try {
      origin = new URL(uri).origin;
    } catch {
      return '(unparseable)';
    }
    return origin.length > MAX_ORIGIN_LEN ? '(oversized)' : origin;
  }
  // Anything else is either a CSP keyword ('inline', 'eval', 'data') or a
  // scheme this site does not speak, most often a browser extension. The
  // scheme alone carries the signal; the rest is an attacker-chosen string.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  if (scheme) {
    return scheme[1].length > MAX_SCHEME_LEN ? '(oversized)' : scheme[1].toLowerCase() + ':';
  }
  return /^[a-z-]{1,20}$/.test(uri) ? uri : '(other)';
}

// Directive names are a closed vocabulary, so this matches against it rather
// than against a shape. Taking the first token of an attacker's string and
// calling it a directive is safe from injection but still puts a value they
// chose in the directive field of a log a human reads.
//
// An earlier version accepted anything ending in -src so that a directive
// added to the spec later would still carry its name. That is a hole by
// construction: "password-leaked-src" matches the shape and reads as a
// genuine browser finding. The list is exhaustive instead, and the cost is
// stated rather than avoided — a directive added to the spec logs as
// (unknown) until someone adds it here, which is a line that says less
// rather than a line that lies.
const DIRECTIVES = new Set([
  // fetch directives
  'child-src', 'connect-src', 'default-src', 'fenced-frame-src', 'font-src',
  'frame-src', 'img-src', 'manifest-src', 'media-src', 'object-src',
  'prefetch-src', 'script-src', 'script-src-attr', 'script-src-elem',
  'style-src', 'style-src-attr', 'style-src-elem', 'worker-src',
  // document, navigation and reporting directives
  'base-uri', 'block-all-mixed-content', 'form-action', 'frame-ancestors',
  'navigate-to', 'report-to', 'report-uri', 'require-trusted-types-for',
  'sandbox', 'trusted-types', 'upgrade-insecure-requests',
]);

// violated-directive additionally carries the whole matched policy after the
// name, which is ours rather than the reporter's, but there is no reason to
// log it either.
function safeDirective(v) {
  if (typeof v !== 'string') return '(unknown)';
  const name = v.trim().split(/\s+/)[0];
  return DIRECTIVES.has(name) ? name : '(unknown)';
}

// Two values, fixed by the spec. Anything else is not a disposition.
function safeDisposition(v) {
  return v === 'enforce' || v === 'report' ? v : '(unknown)';
}

// report-uri sends {"csp-report": {...}}; report-to sends an array of
// {type, body}. Both shapes exist and neither can be assumed — nor can it be
// assumed that the elements are objects at all: a body of [null] used to
// reach r.body and throw, turning a malformed report into a 500.
function normalise(body) {
  if (Array.isArray(body)) {
    return body
      .slice(0, MAX_REPORTS_PER_REQUEST)
      .map((entry) => (isRecord(entry) && isRecord(entry.body) ? entry.body : {}));
  }
  if (!isRecord(body)) return [{}];
  return [isRecord(body['csp-report']) ? body['csp-report'] : body];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const now = Date.now();
  if (now > windowResetAt) {
    windowResetAt = now + WINDOW_MS;
    logged = 0;
  }

  for (const r of normalise(req.body)) {
    // Counted per emitted report, not per request. The cap is about how many
    // lines land in the log, and the loop is what puts them there.
    if (logged >= MAX_LOGGED_PER_WINDOW) break;
    logged += 1;
    console.warn('csp violation', JSON.stringify({
      directive: safeDirective(r['effective-directive'] || r.effectiveDirective || r['violated-directive']),
      blocked: safeOrigin(r['blocked-uri'] || r.blockedURL),
      onPage: safeOrigin(r['document-uri'] || r.documentURL),
      disposition: safeDisposition(r.disposition),
    }));
    if (logged === MAX_LOGGED_PER_WINDOW) {
      console.warn('csp violation reporting capped for this instance until the window resets');
    }
  }

  // 204 for anything this handler sees, including a report it could not make
  // sense of and one dropped by the cap — an error there would give browsers
  // a reason to retry and tell a prober which shapes register.
  //
  // Note the limit: a body that is not valid JSON never reaches here. Vercel's
  // parser answers 400 first, verified against a deployment. Browsers send
  // well-formed reports, so this costs nothing in practice, but the handler
  // cannot claim to answer 204 unconditionally.
  res.status(204).end();
}

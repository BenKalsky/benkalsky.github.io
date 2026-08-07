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
//
// Everything this returns is either a fixed literal or drawn from a list.
// A shape check is not enough: "password-leaked://x" and "credential-stolen"
// both pass one, and both then read as a genuine browser finding in a log
// whose whole job is telling those from fabricated input. Same reasoning as
// the directive vocabulary below.
const KEYWORDS = new Set([
  'inline', 'eval', 'data', 'blob', 'filesystem', 'media', 'self',
  'unsafe-eval', 'unsafe-inline', 'wasm-eval',
  'trusted-types-policy', 'trusted-types-sink',
]);
const SCHEMES = new Set([
  'http', 'https', 'data', 'blob', 'filesystem', 'about', 'ws', 'wss',
  'chrome-extension', 'moz-extension', 'safari-extension',
  'safari-web-extension', 'webkit-masked-url',
]);

// A serialized origin is scheme + "://" + host + an optional port. A DNS name
// may reach 253 characters, and punycode makes long IDNs ordinary, so a real
// origin can approach 270 — an earlier cap of 100 discarded valid ones and
// with them the domain the log exists to name.
const MAX_AUTHORITY_LEN = 300;

function safeOrigin(uri) {
  if (typeof uri !== 'string' || !uri) return '(none)';

  // The authority is matched on its own, so a path or query of any length is
  // never parsed and never measured. Bounding the whole URI instead — as an
  // earlier version did at 4096 — throws away a short, useful origin because
  // of a long suffix the function was never going to keep. Scheme matching is
  // case-insensitive per RFC 3986 §3.1; before that, startsWith('http') let
  // "HTTPS://host/path?token=..." through with its query intact.
  const authority = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(uri);
  if (authority) {
    const scheme = authority[1].toLowerCase();
    if (!SCHEMES.has(scheme)) return '(other)';
    if (scheme !== 'http' && scheme !== 'https') return scheme + ':';
    if (authority[2].length > MAX_AUTHORITY_LEN) return '(oversized)';
    try {
      return new URL(scheme + '://' + authority[2]).origin;
    } catch {
      return '(unparseable)';
    }
  }

  // Schemes that carry no authority — data:, blob:, about: — and then the
  // bare CSP keywords.
  const bare = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  if (bare) {
    const scheme = bare[1].toLowerCase();
    return SCHEMES.has(scheme) ? scheme + ':' : '(other)';
  }
  return KEYWORDS.has(uri) ? uri : '(other)';
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

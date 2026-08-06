// Collector for Content-Security-Policy violation reports.
//
// Without this the policy is enforced blind: a violation in a browser we did
// not test is invisible until someone notices analytics stopped. Reports land
// in the Vercel function logs, which is where every other diagnosis in this
// project has started.
//
// Browsers post here with no Origin header and no user gesture, so this
// endpoint deliberately does NOT reuse the contact form's origin check. What
// keeps it cheap to abuse is that it stores nothing, sends nothing and always
// answers 204.

// Reports are bursty by nature — one bad tag produces one per page view — so
// the log is capped per instance. State is per warm instance, same caveat as
// the contact rate limiter: a soft cap, not a guarantee.
const MAX_LOGGED_PER_WINDOW = 50;
const WINDOW_MS = 60 * 60 * 1000;
let logged = 0;
let windowResetAt = 0;

// A directive plus the blocked URI's origin is enough to identify a
// violation. The full URI can carry a path and query, which on a page with a
// query string can carry whatever was in it — none of which is needed here.
function safeOrigin(uri) {
  if (!uri || typeof uri !== 'string') return '(none)';
  if (!uri.startsWith('http')) return uri.slice(0, 40); // 'inline', 'eval', 'data'
  try {
    return new URL(uri).origin;
  } catch {
    return '(unparseable)';
  }
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

  if (logged < MAX_LOGGED_PER_WINDOW) {
    logged += 1;
    // Both shapes exist: report-uri sends {"csp-report": {...}}, report-to
    // sends an array of {type, body}. Normalise rather than assume.
    const body = req.body ?? {};
    const reports = Array.isArray(body) ? body.map((r) => r.body ?? {}) : [body['csp-report'] ?? body];
    for (const r of reports) {
      console.warn('csp violation', JSON.stringify({
        directive: r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || '(unknown)',
        blocked: safeOrigin(r['blocked-uri'] || r.blockedURL),
        onPage: safeOrigin(r['document-uri'] || r.documentURL),
        disposition: r.disposition || 'enforce',
      }));
    }
    if (logged === MAX_LOGGED_PER_WINDOW) {
      console.warn('csp violation reporting capped for this instance until the window resets');
    }
  }

  // Always 204, even when capped or malformed. A reporting endpoint that
  // returns errors gives an attacker a signal and gives browsers a reason to
  // retry, and neither buys us anything.
  res.status(204).end();
}

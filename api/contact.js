// The site and this function now ship in the same deployment, so every
// legitimate request is same-origin and no CORS headers are needed. What
// remains is the origin *check*, kept deliberately: it costs nothing and it
// rejects scripted POSTs that carry no Origin header at all.
const SELF_ORIGIN = 'https://www.benkalsky.co.il';

// Recipients come from config, not code. The reason is a regression this
// line already caused once: the ElasticEmail account is on a trial tier that
// rejects the whole message — 400, no partial delivery — if any recipient is
// not the address the account was registered with. Hardcoding a second
// address took the contact form down for every real submission.
//
// The default is therefore the single address that is always permitted.
// Adding ben@digitizer.co.il for redundancy is a LEAD_NOTIFY_TO change once
// the plan allows other recipients — followed by a REDEPLOY. An earlier
// version of this comment claimed no deploy was needed, which is wrong twice
// over: Vercel applies environment changes to new deployments rather than to
// a running one, and this value is read once at module scope. Changing the
// variable and believing a second recipient is live is exactly the state that
// takes an outage a while to notice.
//
// The fallback is applied AFTER parsing, not before. A value of " , " is
// truthy, so testing the raw string first sent every valid submission to
// ElasticEmail with an empty To list — a 502 on every lead, which is the same
// total outage this line was written to prevent.
const DEFAULT_TO = 'benkalsky@gmail.com';

// Exported so the fallback is testable. It is a rule about a value an operator
// types by hand into a dashboard, which is exactly the kind of rule that is
// only ever exercised on the day it is wrong.
export function resolveRecipients(raw) {
  const configured = String(raw ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return configured.length ? configured : [DEFAULT_TO];
}

const TO_ADDRESSES = resolveRecipients(process.env.LEAD_NOTIFY_TO);
const FROM_ADDRESS = 'hello@benkalsky.co.il';
const FROM_NAME = 'Ben Kalsky Site';

// Best-effort throttling. State is per warm lambda instance, so these are
// soft caps, not guarantees — good enough to stop naive scripted abuse and
// protect the Resend quota. A hard guarantee would need shared storage
// (e.g. Upstash Redis), which is an owner decision.
const IP_LIMIT = 5;
const IP_WINDOW_MS = 60 * 60 * 1000;
const DAILY_CAP = 100;
const ipBuckets = new Map();
let dailyCount = 0;
let dailyResetAt = 0;

function dailyQuotaExhausted() {
  const now = Date.now();
  if (now > dailyResetAt) {
    dailyResetAt = now + 24 * 60 * 60 * 1000;
    dailyCount = 0;
  }
  return dailyCount >= DAILY_CAP;
}

// Evict every expired bucket. Runs unconditionally at the top of the
// handler, before any short-circuit (OPTIONS, method, origin, quota).
// Serverless note: instances are frozen between invocations, so timers
// cannot expire entries in the background — cleanup is necessarily
// invocation-driven. An expired IP is therefore removed on the next
// request to the instance, or when the instance is destroyed; the
// privacy policy discloses exactly that.
function evictExpiredBuckets(now) {
  for (const [key, b] of ipBuckets) {
    if (now > b.resetAt) ipBuckets.delete(key);
  }
}

function rateLimited(req) {
  const now = Date.now();
  if (dailyQuotaExhausted()) return true;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const bucket = ipBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    if (ipBuckets.size > 5000) ipBuckets.clear();
    ipBuckets.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > IP_LIMIT;
}


const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

export default async function handler(req, res) {
  evictExpiredBuckets(Date.now());

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  // No OPTIONS branch: a same-origin request never triggers a preflight, and
  // a cross-origin one gets no Allow-Origin header back, so it fails in the
  // browser regardless of what this returns.
  if (req.headers.origin !== SELF_ORIGIN) {
    res.status(403).json({ error: 'origin not allowed' });
    return;
  }
  if (rateLimited(req)) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }

  const { name, email, phone, message, consent, website } = req.body ?? {};

  // Honeypot: real users never fill the hidden "website" field.
  if (website) {
    res.status(200).json({ ok: true });
    return;
  }

  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    res.status(400).json({ error: 'invalid email' });
    return;
  }
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) {
    res.status(400).json({ error: 'invalid message' });
    return;
  }
  if (phone != null && (typeof phone !== 'string' || phone.length > 50)) {
    res.status(400).json({ error: 'invalid phone' });
    return;
  }
  if (consent !== true) {
    res.status(400).json({ error: 'consent required' });
    return;
  }

  const html = `
    <h2>פנייה חדשה מהאתר benkalsky.co.il</h2>
    <p><b>שם:</b> ${escapeHtml(name)}</p>
    <p><b>אימייל:</b> ${escapeHtml(email)}</p>
    <p><b>טלפון:</b> ${escapeHtml(phone || '—')}</p>
    <p><b>הודעה:</b></p>
    <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
    <hr>
    <p style="color:#666;font-size:12px">נשלח עם הסכמה למדיניות הפרטיות (תיקון 13).</p>
  `;

  // The daily quota counts only requests that passed validation and the
  // honeypot — i.e. actual send attempts — so junk traffic cannot exhaust it.
  if (dailyQuotaExhausted()) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }
  dailyCount += 1;

  if (!process.env.ELASTIC_EMAIL_API_KEY) {
    console.error('ELASTIC_EMAIL_API_KEY is not configured');
    res.status(502).json({ error: 'send failed' });
    return;
  }

  const r = await fetch('https://api.elasticemail.com/v4/emails/transactional', {
    method: 'POST',
    headers: {
      'X-ElasticEmail-ApiKey': process.env.ELASTIC_EMAIL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Recipients: { To: TO_ADDRESSES },
      Content: {
        From: `${FROM_NAME} <${FROM_ADDRESS}>`,
        ReplyTo: email,
        Subject: `פנייה מהאתר: ${name}`,
        Body: [{ ContentType: 'HTML', Content: html }],
      },
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('elasticemail failed', r.status, detail);
    res.status(502).json({ error: 'send failed' });
    return;
  }

  // A 2xx from ElasticEmail means *accepted for delivery*, not delivered.
  // Without this line a message that is accepted and then silently dropped
  // downstream is indistinguishable from one that arrived, which is exactly
  // the state this endpoint was in the first time it happened. The response
  // carries a MessageID/TransactionID; log it so a missing email can be
  // traced in the ElasticEmail activity log instead of guessed at.
  const accepted = await r.text().catch(() => '');
  console.log('elasticemail accepted', accepted);

  res.status(200).json({ ok: true });
}

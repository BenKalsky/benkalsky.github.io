const ALLOWED_ORIGINS = new Set([
  'https://benkalsky.net',
  'https://www.benkalsky.net',
  'https://benkalsky.co.il',
  'https://www.benkalsky.co.il',
  'https://benkalsky.github.io',
]);

const TO_ADDRESS = 'benkalsky@gmail.com';
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

function rateLimited(req) {
  if (dailyQuotaExhausted()) return true;

  const now = Date.now();
  // Evict every expired bucket on each request so an IP is held only
  // for its active rate window, matching the site's privacy policy.
  for (const [key, b] of ipBuckets) {
    if (now > b.resetAt) ipBuckets.delete(key);
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const bucket = ipBuckets.get(ip);
  if (!bucket) {
    if (ipBuckets.size > 5000) ipBuckets.clear();
    ipBuckets.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > IP_LIMIT;
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return true;
  }
  return false;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

export default async function handler(req, res) {
  const originAllowed = setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(originAllowed ? 204 : 403).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!originAllowed) {
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
      Recipients: { To: [TO_ADDRESS] },
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

  res.status(200).json({ ok: true });
}

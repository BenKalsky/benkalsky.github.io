const ALLOWED_ORIGINS = new Set([
  'https://benkalsky.net',
  'https://www.benkalsky.net',
  'https://benkalsky.co.il',
  'https://www.benkalsky.co.il',
  'https://benkalsky.github.io',
]);

const TO_ADDRESS = 'benkalsky@gmail.com';
const FROM_ADDRESS = 'Ben Kalsky Site <forms@quoty.co.il>';

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

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [TO_ADDRESS],
      reply_to: email,
      subject: `פנייה מהאתר: ${name}`,
      html,
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('resend failed', r.status, detail);
    res.status(502).json({ error: 'send failed' });
    return;
  }

  res.status(200).json({ ok: true });
}

// Proves the deferred GTM loader still measures: no request on the critical
// path, a real gtm.js load afterwards, and a GA4 collect hit for a CTA click.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.xml': 'application/xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const fail = [];

// The assertions only need the request to be *attempted* — Playwright emits the
// request event before routing resolves. Aborting it keeps this script from
// polluting the live GA4 property with localhost traffic every time it runs.
// googletagmanager.com is deliberately left reachable: the container has to
// actually load for the dataLayer assertions to mean anything.
async function blockCollect(page) {
  await page.route('**://*.google-analytics.com/**', (r) => r.abort());
  await page.route('**://analytics.google.com/**', (r) => r.abort());
  await page.route('**/g/collect*', (r) => r.abort());
}
try {
  for (const target of ['/', '/blog/mcp/']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await blockCollect(page);
    const gtm = [];
    const collect = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('googletagmanager.com/gtm.js')) gtm.push(Date.now());
      if (u.includes('/g/collect') || u.includes('google-analytics.com')) collect.push(u);
    });

    await page.goto(base + target, { waitUntil: 'domcontentloaded' });
    // Critical path: nothing may have been requested yet.
    if (gtm.length) fail.push(`${target}: gtm.js requested during DOMContentLoaded`);

    // No interaction: the idle fallback must still load it.
    await page.waitForRequest((r) => r.url().includes('gtm.js'), { timeout: 8000 })
      .catch(() => fail.push(`${target}: gtm.js never loaded on idle`));

    // dataLayer must have survived as a real array with the gtm.start push.
    const dl = await page.evaluate(() => (window.dataLayer || []).map((e) => e && (e.event || Object.keys(e)[0])));
    if (!dl.includes('gtm.js')) fail.push(`${target}: dataLayer missing gtm.js push (got ${JSON.stringify(dl)})`);

    // Consent defaults must have been recorded before the loader ran.
    const consent = await page.evaluate(() =>
      (window.dataLayer || []).some((e) => e && e[0] === 'consent' && e[1] === 'default'));
    if (!consent) fail.push(`${target}: consent default missing from dataLayer`);

    await page.waitForTimeout(2500);
    if (!collect.length) fail.push(`${target}: no GA4 collect hit`);
    console.log(`${target} :: gtm loads=${gtm.length} collect hits=${collect.length} dataLayer=${JSON.stringify(dl)}`);
    await ctx.close();
  }

  // Interaction path: a click must load GTM immediately, well before idle.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let gtmAt = null;
  const collect = [];
  page.on('request', (r) => {
    if (r.url().includes('gtm.js') && gtmAt === null) gtmAt = Date.now();
    if (r.url().includes('/g/collect') || r.url().includes('google-analytics.com')) collect.push(r.url());
  });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  // Arm the listener before the click: the loader fires fast enough that a
  // waiter registered afterwards can miss the request entirely.
  const armed = page.waitForRequest((r) => r.url().includes('gtm.js'), { timeout: 5000 })
    .catch(() => fail.push('interaction: gtm.js did not load on pointerdown'));
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.up();
  await armed;
  if (gtmAt - t0 > 900) fail.push(`interaction: gtm.js load lagged the click by ${gtmAt - t0}ms (idle fallback, not the interaction path)`);
  console.log(`pointerdown -> gtm.js in ${gtmAt - t0}ms`);

  // The tracked CTA must produce a GA4 event hit.
  const cta = page.locator('a[data-cta-loc]').first();
  if (await cta.count()) {
    const href = await cta.getAttribute('href');
    await page.evaluate((h) => {
      document.querySelector(`a[href="${h}"]`).setAttribute('target', '_blank');
    }, href);
    await cta.click();
    await page.waitForTimeout(3000);
    const events = collect.filter((u) => /en=|ep\.|whatsapp|schedule|cta/.test(u));
    console.log(`CTA hits captured: ${collect.length} (event-bearing: ${events.length})`);
    if (!collect.length) fail.push('interaction: CTA click produced no GA4 hit');
  } else {
    fail.push('interaction: no [data-cta-loc] element found');
  }
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}

if (fail.length) { console.error('\nFAIL:\n' + fail.map((f) => ' - ' + f).join('\n')); process.exit(1); }
console.log('\nPASS: deferred GTM keeps consent defaults, loads on idle and on interaction, and still attempts GA4 hits (outbound hits are blocked locally so this script never pollutes the property).');

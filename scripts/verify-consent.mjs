// Proves the consent gate on the session-recording tag, in both directions.
//
// Microsoft Clarity records the visit. It is held back by four independent
// layers, and only one of them lives in this repo:
//
//   1. a Custom Event trigger in GTM, so the tag does not fire on page load
//   2. Consent Mode in Clarity's project settings, so no cookies before consent
//   3. ad_Storage pinned to denied in BlogLayout.astro, so the advertising
//      identity sync is never requested
//   4. c.bing.com absent from the CSP, so the sync is blocked even if asked for
//
// Layers 1 and 2 are configuration outside this repository. Nothing in CI
// notices if either is reverted — verify-csp.mjs will not, because it grants
// consent before every page precisely so the policy entries stay exercised.
// This script is the only thing that would catch it.
//
// It asserts both directions on purpose. "Nothing loaded" is not a passing
// result on its own: it is also what a broken or deleted tag looks like, and a
// test that cannot tell those apart stops being evidence the moment it matters.
//
// Outbound uploads are aborted. The script needs the real GTM container and the
// real Clarity script to prove the chain, but a headless CI run must never land
// a fabricated session in the Clarity project — the same rule the GA4 checks
// follow.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const CONSENT_KEY = 'bk-consent';

// Pages chosen for what a recording of them would contain, not for coverage:
// the home page carries the contact form, and /privacy/ is where a visitor
// goes to read what is being collected about them.
const PAGES = ['/', '/blog/mcp/', '/privacy/'];

const RECORDER = /clarity\.ms/;
const AD_SYNC = /bing\.com/;
// Clarity's own upload path. Allowed to be requested, never allowed to arrive.
const UPLOAD = /clarity\.ms\/(collect|c\.gif)/;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain',
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const fail = [];

async function load(page, consented) {
  const ctx = await browser.newContext();
  const tab = await ctx.newPage();

  // Never let a headless run write to a live property.
  await tab.route('**://*.google-analytics.com/**', (r) => r.abort());
  await tab.route('**://analytics.google.com/**', (r) => r.abort());
  await tab.route('**/g/collect*', (r) => r.abort());
  await tab.route('**://*.clarity.ms/**', (route, request) =>
    (UPLOAD.test(request.url()) ? route.abort() : route.continue()));

  const seen = [];
  tab.on('request', (r) => {
    const u = r.url();
    if (RECORDER.test(u) || AD_SYNC.test(u)) seen.push(u);
  });

  if (consented) {
    await tab.addInitScript(([key]) => {
      try { localStorage.setItem(key, 'granted'); } catch (e) { /* storage blocked */ }
    }, [CONSENT_KEY]);
  }

  await tab.goto(base + page, { waitUntil: 'load' });
  // GTM is deferred until interaction or idle. Force it, then leave time for
  // the container to evaluate its triggers and for the tag to load if allowed.
  await tab.mouse.move(300, 300);
  await tab.mouse.down();
  await tab.mouse.up();
  await tab.waitForTimeout(6000);
  await ctx.close();
  return seen;
}

let recorderEverLoaded = false;

for (const page of PAGES) {
  const denied = await load(page, false);
  const granted = await load(page, true);

  // Before consent: nothing from the recorder at all. Not the tag, not the
  // script, not a pixel.
  if (denied.length) {
    fail.push(`${page}: ${denied.length} recorder request(s) before consent — ${denied[0]}`);
  }

  // After consent: the recorder must actually load, or the check above is
  // passing for the wrong reason.
  const loaded = granted.filter((u) => RECORDER.test(u));
  if (!loaded.length) {
    fail.push(`${page}: consent granted and the recorder never loaded — the gate cannot be distinguished from a broken tag`);
  } else {
    recorderEverLoaded = true;
  }

  // The advertising identity sync is not permitted in either state.
  const sync = [...denied, ...granted].filter((u) => AD_SYNC.test(u));
  if (sync.length) {
    fail.push(`${page}: advertising identity sync attempted — ${sync[0].split('&')[0]}`);
  }

  console.log(
    `${denied.length === 0 && loaded.length > 0 && sync.length === 0 ? '✓' : '✗'} ${page} ` +
    `:: before consent ${denied.length} · after consent ${loaded.length} · ad sync ${sync.length}`
  );
}

await browser.close();
server.close();

if (!recorderEverLoaded) {
  console.error(
    '\nThe recorder did not load on any page even with consent granted.\n' +
    'If this machine has no network access the result says nothing about the\n' +
    'gate — it needs the live GTM container and the live Clarity script.'
  );
}

if (fail.length) {
  console.error('\nConsent gate FAILED:');
  for (const f of fail) console.error('  - ' + f);
  console.error(
    '\nWhat to check, in order: the Clarity tag in GTM is triggered on the\n' +
    'custom event bk_consent_granted and not on All Pages; the Cookies toggle\n' +
    'in Clarity project settings is off; ad_Storage is still pinned to denied\n' +
    'in src/layouts/BlogLayout.astro; c.bing.com is still absent from csp.json.'
  );
  process.exit(1);
}

console.log(`\nConsent gate holds: ${PAGES.length} pages, recorder silent before consent and live after it, no advertising sync in either state.`);

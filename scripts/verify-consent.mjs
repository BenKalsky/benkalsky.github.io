// Proves the consent gate on the session-recording tag, in both directions.
//
// PostHog records the visit, through a first-party reverse proxy at
// t.benkalsky.co.il. It is held back by one layer that lives in this repo and
// one that does not:
//
//   1. a Custom Event trigger in GTM on bk_consent_granted, so the tag does
//      not fire on page load — configuration, outside this repository
//   2. the consent signal itself, in BlogLayout.astro and public/index.html
//
// Nothing else in CI notices if the trigger is reverted to All Pages.
// verify-csp.mjs will not, because it grants consent before every page
// precisely so the policy entries stay exercised. This script is the only
// thing that would catch it.
//
// It has caught two things already: the home page carrying its own copy of the
// consent logic and therefore recording nothing at all, and a session recorder
// disappearing from the GTM container entirely.
//
// It asserts both directions on purpose. "Nothing loaded" is not a passing
// result on its own: it is also what a broken or deleted tag looks like, and a
// test that cannot tell those apart stops being evidence the moment it matters.
//
// Outbound uploads are aborted. The script needs the real GTM container and the
// real recorder to prove the chain, but a headless CI run must never land a
// fabricated session in the live project — the same rule the GA4 checks follow.
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

// Anchored to the container rather than to page load; see load().
const GTM_TIMEOUT_MS = 20000;
const RECORDER_TIMEOUT_MS = 20000;
const SILENCE_WINDOW_MS = 5000;

// The recorder reaches PostHog through a first-party reverse proxy, so it
// cannot be matched by vendor name — not having the vendor's name in the
// request is the entire point of the proxy.
const RECORDER = /\/\/t\.benkalsky\.co\.il\//;

// Kept after the vendor swap on purpose. Clarity, the previous recorder,
// redirected its pixel to c.bing.com carrying a per-pageview identity-sync ID,
// and that endpoint is absent from the CSP for exactly that reason. If any
// future recorder reintroduces a sync like it, this fails — rather than it
// being found a second time by reading a log.
const AD_SYNC = /bing\.com/;

// Ingestion paths only. /static/ and /array/ are assets and must be allowed
// through, or the after-consent assertion would pass against a recorder that
// never actually ran; /flags/ is read-only and part of init. A CI run must
// never write a fabricated session into the live project.
const UPLOAD = /\/\/t\.benkalsky\.co\.il\/(i|e|s)\//;

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
  await tab.route('**://t.benkalsky.co.il/**', (route, request) =>
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

  // Waiting a fixed number of seconds makes the result depend on how fast the
  // runner's network happens to be that minute, and a slow minute reads as a
  // reverted gate. Both waits are anchored to GTM actually loading instead.
  let containerLoaded = false;
  const container = tab
    .waitForRequest((r) => /googletagmanager\.com\/gtm\.js/.test(r.url()), { timeout: GTM_TIMEOUT_MS })
    .then(() => { containerLoaded = true; })
    .catch(() => { /* reported by the caller, not here */ });

  await tab.goto(base + page, { waitUntil: 'load' });
  // GTM is deferred until interaction or idle. Force it.
  await tab.mouse.move(300, 300);
  await tab.mouse.down();
  await tab.mouse.up();
  await container;

  if (containerLoaded) {
    if (consented) {
      // Resolve as soon as the recorder appears; only a real absence costs the
      // full timeout.
      await tab
        .waitForRequest((r) => RECORDER.test(r.url()), { timeout: RECORDER_TIMEOUT_MS })
        .catch(() => { /* absence is the finding, handled by the caller */ });
    } else {
      // Proving absence needs a window, but it starts from the container being
      // up rather than from page load, so it measures the same thing on every
      // machine.
      await tab.waitForTimeout(SILENCE_WINDOW_MS);
    }
  }

  await ctx.close();
  return { seen, containerLoaded };
}

let recorderEverLoaded = false;

for (const page of PAGES) {
  const deniedRun = await load(page, false);
  const grantedRun = await load(page, true);
  const denied = deniedRun.seen;
  const granted = grantedRun.seen;

  // A run where the container never loaded proves nothing in either
  // direction, and must not be reported as a gate failure — that is how a
  // network problem gets mistaken for a reverted trigger.
  if (!deniedRun.containerLoaded || !grantedRun.containerLoaded) {
    fail.push(`${page}: the GTM container did not load within ${GTM_TIMEOUT_MS / 1000}s — this run says nothing about the gate`);
    console.log(`✗ ${page} :: GTM container never loaded`);
    continue;
  }

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
    'gate — it needs the live GTM container and the live PostHog proxy.'
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

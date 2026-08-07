// Proves the consent gate on the session-recording tag, in all three
// directions: silent before consent, actually running after it, and actually
// stopped when consent is withdrawn.
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
// It asserts every direction on purpose. "Nothing loaded" is not a passing
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

// The same policy production serves. Without it this run would not notice a
// recorder feature that the CSP blocks — the recorder builds its canvas worker
// from a blob: URL and falls back to a data: one, and both are refused under
// this policy in Chromium, Firefox and WebKit alike (measured 2026-08-07;
// worker-src falls back through child-src to script-src, not to default-src).
// Today that path is never taken, because canvas capture is off. If it is ever
// switched on, replay degrades silently in every engine — so the violation
// assertion below is what turns that into a red build instead of a mystery.
const CSP = JSON.parse(readFileSync(path.resolve(process.cwd(), 'csp.json'), 'utf8')).policy;

// Pages chosen for what a recording of them would contain, not for coverage:
// the home page carries the contact form, and /privacy/ is where a visitor
// goes to read what is being collected about them.
const PAGES = ['/', '/blog/mcp/', '/privacy/'];

// Anchored to the container being ready to run; see waitForContainer().
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
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'content-security-policy': CSP,
  });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const fail = [];

async function open(page, consent) {
  const ctx = await browser.newContext();
  const tab = await ctx.newPage();

  // Never let a headless run write to a live property. GA4 is answered with an
  // empty 204 rather than aborted: an aborted collect endpoint makes gtag retry
  // against www.google.com/g/collect, which this policy blocks, and the run
  // would then be measuring the abort rather than the site (measured
  // 2026-08-07 — it produced a connect-src violation that does not exist in
  // production).
  const ok204 = (r) => r.fulfill({ status: 204, body: '' });
  await tab.route('**://*.google-analytics.com/**', ok204);
  await tab.route('**://analytics.google.com/**', ok204);
  await tab.route('**/g/collect*', ok204);
  await tab.route('**://t.benkalsky.co.il/**', (route, request) =>
    (UPLOAD.test(request.url()) ? route.abort() : route.continue()));

  const seen = [];
  tab.on('request', (r) => {
    const u = r.url();
    if (RECORDER.test(u) || AD_SYNC.test(u)) seen.push({ url: u, at: Date.now() });
  });

  const violations = [];
  // Seeded only when the key is absent. An init script runs again on every
  // navigation, and the revoke path reloads — re-asserting the granted state
  // there would overwrite the very refusal being tested, and the recorder
  // would legitimately start again on the reloaded page.
  await tab.addInitScript(([key, state]) => {
    try {
      if (state && !localStorage.getItem(key)) localStorage.setItem(key, state);
    } catch (e) { /* storage blocked */ }
    window.__csp = window.__csp || [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
    });
  }, [CONSENT_KEY, consent]);

  return { ctx, tab, seen, violations };
}

// waitForRequest resolves the moment the browser *sends* the request, which on
// a slow runner can be seconds before the container has downloaded, let alone
// run. A silence window started there can expire before a reverted All Pages
// tag has had any chance to fire, and the run would report a gate that holds
// when nothing was ever tested. Anchor to the container being ready to execute.
async function waitForContainer(tab) {
  try {
    await tab.waitForResponse(
      (r) => /googletagmanager\.com\/gtm\.js/.test(r.url()) && r.status() === 200,
      { timeout: GTM_TIMEOUT_MS }
    );
    await tab.waitForFunction(() => !!window.google_tag_manager, null, { timeout: GTM_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

// GTM is deferred until interaction or idle. Force it.
async function nudge(tab) {
  await tab.mouse.move(300, 300);
  await tab.mouse.down();
  await tab.mouse.up();
}

// Matching the proxy host proves the library was fetched, not that recording
// started: /static/array.js and the read-only /flags/ request both match it,
// and both happen even when session recording is disabled or its chunk fails
// to load. The recorder's own runtime state is the only signal that answers
// the question actually being asked.
const recordingState = (tab) => tab.evaluate(() => {
  const ph = window.posthog;
  if (!ph || typeof ph.sessionRecordingStarted !== 'function') return false;
  try { return ph.sessionRecordingStarted() === true; } catch (e) { return false; }
});

async function waitForRecording(tab) {
  try {
    await tab.waitForFunction(() => {
      const ph = window.posthog;
      return !!ph && typeof ph.sessionRecordingStarted === 'function' && ph.sessionRecordingStarted() === true;
    }, null, { timeout: RECORDER_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

const cspOf = (tab) => tab.evaluate(() => window.__csp || []);

let recorderEverRan = false;

for (const page of PAGES) {
  // ---- before consent: nothing from the recorder at all ----
  const d = await open(page, null);
  await d.tab.goto(base + page, { waitUntil: 'load' });
  await nudge(d.tab);
  const dReady = await waitForContainer(d.tab);
  if (dReady) await d.tab.waitForTimeout(SILENCE_WINDOW_MS);
  const denied = d.seen.map((s) => s.url);
  const deniedCsp = await cspOf(d.tab);
  await d.ctx.close();

  // ---- after consent: the recorder must actually be running ----
  const g = await open(page, 'granted');
  await g.tab.goto(base + page, { waitUntil: 'load' });
  await nudge(g.tab);
  const gReady = await waitForContainer(g.tab);
  const running = gReady ? await waitForRecording(g.tab) : false;
  const granted = g.seen.map((s) => s.url);
  const grantedCsp = await cspOf(g.tab);

  // ---- consent withdrawn on the same page: it must actually stop ----
  // Only meaningful if it was running in the first place; otherwise the
  // "stopped" result would be indistinguishable from never having started.
  let revoked = null;
  if (running) {
    const at = Date.now();
    await g.tab.click('#cookie-settings');
    await g.tab.click('#consent-decline');
    // decide() reloads when it finds a live recorder, so the assertion has to
    // survive a navigation.
    await g.tab.waitForLoadState('load');
    await g.tab.waitForTimeout(2000);
    revoked = {
      stillRunning: await recordingState(g.tab),
      after: g.seen.filter((s) => s.at > at + 1500).map((s) => s.url),
    };
  }
  await g.ctx.close();

  // A run where the container never became ready proves nothing in either
  // direction, and must not be reported as a gate failure — that is how a
  // network problem gets mistaken for a reverted trigger.
  if (!dReady || !gReady) {
    fail.push(`${page}: the GTM container was not ready within ${GTM_TIMEOUT_MS / 1000}s — this run says nothing about the gate`);
    console.log(`✗ ${page} :: GTM container never became ready`);
    continue;
  }

  if (denied.length) {
    fail.push(`${page}: ${denied.length} recorder request(s) before consent — ${denied[0]}`);
  }

  if (!running) {
    fail.push(`${page}: consent granted and session recording never started — the gate cannot be distinguished from a broken tag`);
  } else {
    recorderEverRan = true;
    if (revoked.stillRunning) {
      fail.push(`${page}: consent withdrawn and the recorder kept running — the privacy page promises otherwise`);
    }
    if (revoked.after.length) {
      fail.push(`${page}: ${revoked.after.length} recorder request(s) after consent was withdrawn — ${revoked.after[0]}`);
    }
  }

  // The advertising identity sync is not permitted in any state.
  const sync = [...denied, ...granted].filter((u) => AD_SYNC.test(u));
  if (sync.length) {
    fail.push(`${page}: advertising identity sync attempted — ${sync[0].split('&')[0]}`);
  }

  // A CSP violation here is the recorder asking for something the policy
  // refuses — a worker scheme, an unlisted host. It is a silent partial
  // failure in production, so it fails the build.
  const csp = [...new Set([...deniedCsp, ...grantedCsp])];
  if (csp.length) {
    fail.push(`${page}: the recorder tripped the CSP — ${csp[0]}`);
  }

  console.log(
    `${denied.length === 0 && running && !revoked?.stillRunning && !revoked?.after.length && sync.length === 0 && csp.length === 0 ? '✓' : '✗'} ${page} ` +
    `:: before ${denied.length} · recording ${running ? 'on' : 'off'} · after revoke ${running ? (revoked.stillRunning ? 'still on' : 'off') : 'n/a'} · ad sync ${sync.length} · csp ${csp.length}`
  );
}

await browser.close();
server.close();

if (!recorderEverRan) {
  console.error(
    '\nSession recording did not start on any page even with consent granted.\n' +
    'If this machine has no network access the result says nothing about the\n' +
    'gate — it needs the live GTM container and the live PostHog proxy.'
  );
}

if (fail.length) {
  console.error('\nConsent gate FAILED:');
  for (const f of fail) console.error('  - ' + f);
  console.error(
    '\nWhat to check, in order: the PostHog tag in GTM is triggered on the\n' +
    'custom event bk_consent_granted and not on All Pages; session recording is\n' +
    'still enabled in the PostHog project; window.bkStopRecording is still wired\n' +
    'into decide() in BOTH src/layouts/BlogLayout.astro and public/index.html;\n' +
    'c.bing.com is still absent from csp.json.'
  );
  process.exit(1);
}

console.log(`\nConsent gate holds: ${PAGES.length} pages, recorder silent before consent, running after it, stopped when it is withdrawn, no advertising sync and no CSP violation in any state.`);

// Proves the consent gate on the session-recording tag, in every direction:
// absent before consent, running after a first-time visitor accepts, running
// for a returning visitor whose choice is stored, and actually stopped when
// consent is withdrawn — including a withdrawal made while the grant is still
// queued.
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
// Time the recorder is left running before its violations are read, so a
// resource it loads lazily has happened by then.
const EXERCISE_MS = 4000;
// How long the GTM container is held back in the race check, so the
// withdrawal lands while the grant is still queued. The watch that follows is
// anchored to the container arriving rather than to a fixed window.
const CONTAINER_DELAY_MS = 5000;
// How long the page is watched for a recorder object AFTER the pre-consent
// activity. The silence window above ends before that activity runs, so this
// is the only window that covers an initialisation the activity itself caused.
const SETTLE_MS = 5000;

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
//
// KNOWN LIMIT, measured 2026-08-07: this abort has never fired. Seventy
// seconds of scripted activity with sessionRecordingStarted() true throughout
// produced zero requests to any ingestion path, and so did an explicit
// posthog.capture() with every POST to the proxy recorded before being
// dropped. The library reports __loaded, the recorder reports started, the
// config is ordinary (localStorage+cookie, batching on, not opted out) — and
// nothing is ever sent.
//
// It is the harness, not the site: a real consented visit the same day
// produced a 48-second replay and four event types in the live project. The
// cause of the difference is not identified.
//
// What follows from that: the "nothing after the revoke" assertion below
// proves no NEW upload was attempted. It does NOT prove an already-buffered
// one was discarded, because nothing here ever gets far enough to flush. The
// privacy page is worded to claim only the former. If a future run ever trips
// this abort, that assertion becomes the stronger one it currently is not —
// and this comment should be deleted rather than trusted.
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

async function open(page, consent, opts = {}) {
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

  // Holds the GTM container back, not the recorder. The tag's own snippet
  // defines window.posthog synchronously the moment the tag fires, so once the
  // container is up there is always something for bkStopRecording() to find.
  // The window that matters is earlier: the accept lands in the dataLayer
  // while GTM is still loading — which here it always is, because the loader
  // is deferred until exactly the interaction that the accept click is. A
  // withdrawal inside that window has no window.posthog to stop.
  //
  // Real but short, a few hundred milliseconds. A test that has to win that
  // race by luck is not a test, so the container is delayed to widen it.
  if (opts.delayContainer) {
    await tab.route('**://www.googletagmanager.com/gtm.js**', async (route) => {
      await new Promise((r) => setTimeout(r, CONTAINER_DELAY_MS));
      await route.continue();
    });
  }

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
// when nothing was ever tested.
//
// Deliberately not waitForResponse either: that only sees responses arriving
// after it is called, so a cached container fetched and executed during the
// nudge would never be seen and the run would report an unavailable container
// for twenty seconds while GTM was in fact ready. Polling the runtime state
// answers the question directly and cannot lose a race with it.
async function waitForContainer(tab) {
  try {
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
  // Activity worth capturing, before any decision: pointer movement, scroll,
  // and — where the page has one — keystrokes into a form field. A recorder
  // that buffers this in memory and uploads it once consent arrives is
  // invisible to a check that watches the network, because there is nothing on
  // the network yet.
  await d.tab.mouse.move(420, 260);
  await d.tab.mouse.wheel(0, 400);
  const field = d.tab.locator('#contact input[type="text"], #contact input[name="name"]').first();
  if (await field.count()) await field.fill('בדיקה לפני הסכמה').catch(() => {});
  // The structural answer to buffering, and the only one this harness can give
  // (see UPLOAD above — nothing here ever reaches an ingestion path, so a
  // payload cannot be inspected): before consent the recorder is not held back,
  // it is ABSENT. No library object, therefore no buffer, therefore nothing to
  // flush when consent arrives. If a future design loads the library and
  // configures it not to record, this fails, and it should — that design needs
  // an assertion about its buffer, which this one cannot make.
  //
  // Polled for a window rather than sampled once. The silence window above
  // expires BEFORE this activity happens, so a single read taken straight
  // afterwards races an asynchronous initialisation that the activity itself
  // triggered: a tag fired on the interaction would still be loading, the read
  // would see undefined, and the accept-side wait a moment later would find the
  // recorder already starting and credit it to consent. This resolves the
  // moment the object appears at any point in the window, which is the same
  // question asked over time instead of at one instant.
  const recorderPresent = await d.tab
    .waitForFunction(() => typeof window.posthog !== 'undefined', null, { timeout: SETTLE_MS })
    .then(() => true, () => false);
  const denied = d.seen.map((s) => s.url);
  const deniedCsp = await cspOf(d.tab);

  // ---- the first-time visitor's accept, in the same context ----
  // Two things at once, both of which the seeded path below cannot see.
  //
  // The seeded path writes 'granted' into localStorage before any application
  // code runs, so it only ever exercises the returning-visitor branch in the
  // document head. Breaking the accept handler's bkSignalConsent() call — the
  // home page's own copy of it, which is where this whole script's first
  // finding came from — would leave a first-time visitor unrecorded while
  // every seeded run stayed green.
  //
  // And it is the same document that was just exercised, so the transition
  // from no-consent to consent happens with that activity behind it, rather
  // than in a fresh context where nothing came before.
  await d.tab.click('#consent-accept');
  const firstTimeStarted = await waitForRecording(d.tab);
  await d.ctx.close();

  // ---- after consent: the recorder must actually be running ----
  const g = await open(page, 'granted');
  await g.tab.goto(base + page, { waitUntil: 'load' });
  await nudge(g.tab);
  const gReady = await waitForContainer(g.tab);
  const running = gReady ? await waitForRecording(g.tab) : false;
  // Snapshotting the violations the instant recording starts would miss
  // anything the recorder loads afterwards — a worker built lazily for canvas
  // capture is exactly that shape. Exercise the page first, and read before
  // the revoke: the reload replaces the document and with it window.__csp.
  if (running) {
    await g.tab.mouse.move(500, 400);
    await g.tab.mouse.wheel(0, 600);
    await g.tab.waitForTimeout(EXERCISE_MS);
  }
  const granted = g.seen.map((s) => s.url);
  const grantedCsp = await cspOf(g.tab);

  // ---- consent withdrawn on the same page: it must actually stop ----
  // Only meaningful if it was running in the first place; otherwise the
  // "stopped" result would be indistinguishable from never having started.
  let revoked = null;
  if (running) {
    await g.tab.click('#cookie-settings');
    // The boundary is the decline, not the settings click. Taken earlier, an
    // upload triggered by the settings click itself — while consent was still
    // granted — would be counted as an upload after withdrawal.
    const at = Date.now();
    await g.tab.click('#consent-decline');
    // decide() reloads when it finds a live recorder, so the assertion has to
    // survive a navigation.
    await g.tab.waitForLoadState('load');
    await g.tab.waitForTimeout(4000);
    revoked = {
      stillRunning: await recordingState(g.tab),
      // No grace period. An earlier version ignored the first 1.5s, which is
      // precisely the window in which an unload flush would land — the reload
      // that is supposed to end the buffer can also be what ships it. Counting
      // from the click is the only version of this assertion that can fail for
      // the reason it exists.
      after: g.seen.filter((s) => s.at >= at).map((s) => s.url),
    };
  }
  await g.ctx.close();

  // ---- withdrawn while the grant is still in flight ----
  // The accept queues bk_consent_granted in the dataLayer, and GTM replays it
  // whenever the container finishes loading. A withdrawal made inside that
  // window used to be overtaken by its own accept: there was no window.posthog
  // to stop, so nothing reloaded, and the tag then fired against a stored
  // 'denied'. The check above cannot see this — it waits for recording to
  // start before revoking, which is precisely the case that does not apply.
  const r = await open(page, null, { delayContainer: true });
  await r.tab.goto(base + page, { waitUntil: 'load' });
  // No nudge and no wait for the container: the accept click is itself the
  // first interaction, so both decisions are made while GTM is still in
  // flight. Waiting for the container first would close the very window under
  // test — which an earlier version of this check did, and passed for it.
  await r.tab.click('#consent-accept');
  await r.tab.click('#cookie-settings');
  await r.tab.click('#consent-decline');
  await r.tab.waitForLoadState('load');
  // The watch is anchored to the container arriving, not to a fixed number of
  // seconds after the clicks. A container held back by CONTAINER_DELAY_MS and
  // then a slow runner can become ready near the end of any fixed window, and
  // the sample would land before the tag had a chance to load — reporting a
  // gate that holds on exactly the runs where it is most likely not to.
  //
  // Waiting here does not reopen the hole the earlier version had: the
  // decisions are already made. And the bound is the same one the granted
  // path allows itself, so the two cannot disagree about how long a recorder
  // is given to start.
  const rReady = await waitForContainer(r.tab);
  const raceStarted = rReady ? await waitForRecording(r.tab) : false;
  await r.ctx.close();

  // A run where the container never became ready proves nothing in either
  // direction, and must not be reported as a gate failure — that is how a
  // network problem gets mistaken for a reverted trigger.
  if (!dReady || !gReady || !rReady) {
    fail.push(`${page}: the GTM container was not ready within ${GTM_TIMEOUT_MS / 1000}s — this run says nothing about the gate`);
    console.log(`✗ ${page} :: GTM container never became ready`);
    continue;
  }

  if (denied.length) {
    fail.push(`${page}: ${denied.length} recorder request(s) before consent — ${denied[0]}`);
  }

  if (recorderPresent) {
    fail.push(`${page}: the recorder library is present in the page before any consent decision — network silence no longer proves nothing was captured, because a buffer can exist`);
  }

  if (!firstTimeStarted) {
    fail.push(`${page}: accepting from the banner as a first-time visitor did not start recording — the seeded runs below only exercise the returning-visitor branch`);
  } else {
    recorderEverRan = true;
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

  if (raceStarted) {
    fail.push(`${page}: consent withdrawn while the grant was still queued, and recording started anyway`);
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

  const clean = denied.length === 0 && !recorderPresent && firstTimeStarted && running &&
    !revoked?.stillRunning && !revoked?.after.length && !raceStarted &&
    sync.length === 0 && csp.length === 0;
  console.log(
    `${clean ? '✓' : '✗'} ${page} ` +
    `:: before ${denied.length} req/${recorderPresent ? 'library present' : 'no library'} ` +
    `· first-time accept ${firstTimeStarted ? 'records' : 'silent'} · recording ${running ? 'on' : 'off'} ` +
    `· after revoke ${running ? (revoked.stillRunning ? 'still on' : 'off') : 'n/a'} ` +
    `· race ${raceStarted ? 'started' : 'off'} · ad sync ${sync.length} · csp ${csp.length}`
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

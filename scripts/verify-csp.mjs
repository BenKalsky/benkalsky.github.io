// Serves dist/ with the candidate CSP and loads every page in a real browser,
// collecting violations. A CSP that is wrong fails silently in production —
// analytics stop, the form stops — so it gets proven here first.
//
// The policy lives in csp.json so vercel.json and this check cannot drift.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const cfg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'csp.json'), 'utf8'));
const CSP = cfg.policy;
const EXPECTED = cfg.expectedBlocked ?? [];

// vercel.json is what production actually serves. If it has drifted from
// csp.json then this check is proving a policy nobody is using.
//
// Every applicable header is enumerated, not just the first exact-case match.
// Browsers enforce multiple CSP headers CUMULATIVELY — the intersection, not
// the last one — so a second rule adding a stricter policy would break a route
// while this script tested only csp.json and reported clean. Header names are
// case-insensitive per RFC 9110, so `content-security-policy` in a second rule
// was invisible to an exact-case find(). Report-Only is collected separately:
// it enforces nothing, but a policy that exists only in report-only mode is
// almost always a policy someone meant to enforce.
const vercelCfg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
const allHeaders = (vercelCfg.headers ?? []).flatMap((r) =>
  (r.headers ?? []).map((h) => ({ source: r.source, key: String(h.key).toLowerCase(), value: h.value })));
const enforced = allHeaders.filter((h) => h.key === 'content-security-policy');
const reportOnly = allHeaders.filter((h) => h.key === 'content-security-policy-report-only');

if (enforced.length !== 1) {
  console.error(
    enforced.length === 0
      ? 'vercel.json serves no Content-Security-Policy. This script would be proving a policy nobody is using.'
      : `vercel.json serves ${enforced.length} Content-Security-Policy headers, on: ` +
        enforced.map((h) => h.source).join(', ') +
        '\nBrowsers apply them cumulatively, so the effective policy is their intersection and not any one of them.' +
        '\nThis script can only prove a single policy. Collapse them into csp.json.'
  );
  process.exit(1);
}
if (enforced[0].value !== CSP) {
  console.error('csp.json and vercel.json disagree. Production serves:\n  ' + enforced[0].value);
  process.exit(1);
}
if (reportOnly.length) {
  console.error(
    `vercel.json also serves ${reportOnly.length} Content-Security-Policy-Report-Only header(s), on: ` +
    reportOnly.map((h) => h.source).join(', ') +
    '\nNothing here proves that policy, and a policy left in report-only mode is usually one someone meant to enforce.'
  );
  process.exit(1);
}

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

const pages = [];
for await (const f of glob('**/*.html', { cwd: DIST })) {
  pages.push('/' + f.replace(/index\.html$/, ''));
}
pages.sort();

// A gate must fail closed. On a checkout where dist/ has not been built the
// glob yields nothing, the loop below never runs, and the script printed
// "CSP clean: 0 pages" and exited 0 — a green result for having tested
// nothing at all. npm run verify:csp does not build, so this is not a
// hypothetical ordering.
if (!pages.length) {
  console.error(
    `No pages found in ${DIST}. Run "npm run build" first — a run with nothing to test is not a clean run.`
  );
  process.exit(1);
}

const GTM_TIMEOUT_MS = 20000;
const SETTLE_MS = 3500;

// A page that loads is not a page that works. connect-src, form-action and
// frame-src are exercised by things a visitor does, not by a page load, so a
// policy that blocks the contact form's fetch would have passed every check
// here: the form was never submitted. These flows drive the directives that a
// load alone leaves untested.
//
// Everything stays on the local server. The form's fetch reaches a path this
// server answers 404 for, which is all the assertion needs — the question is
// whether the policy PERMITS the request, not what comes back. No submitted
// content leaves the process.
async function exerciseFlows(page) {
  // The contact form: fetch() to /api/contact/, gated by connect-src.
  const form = page.locator('form#contact-form, form[data-contact], form').first();
  if (await form.count()) {
    await page.evaluate(async () => {
      try {
        await fetch('/api/contact/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ probe: true }),
        });
      } catch (e) { /* a network failure is not a policy failure */ }
    });
  }
  // The cookie banner, which is what loads every consent-gated tag.
  const settings = page.locator('#cookie-settings');
  if (await settings.count()) {
    await settings.click().catch(() => { /* not on every page */ });
    await page.locator('#consent-accept').click({ timeout: 2000 }).catch(() => {});
  }
  // Scrolling triggers lazy images and any scroll-bound tag.
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch();
const violations = [];
const unreachable = [];
try {
  for (const p of pages) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const seen = [];
    // The spec event is the reliable signal; console messages vary by engine.
    //
    // Consent is granted before the page runs. Consent-gated tags — Clarity
    // among them — never load otherwise, and a policy entry that the run
    // never exercises is a policy entry nobody is checking. The granted
    // state loads strictly more third-party code than the denied one, so
    // testing it covers both.
    await page.addInitScript(() => {
      try { localStorage.setItem('bk-consent', 'granted'); } catch (e) { /* ignore */ }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
      });
    });
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) seen.push(m.text().split('\n')[0]);
    });
    await page.goto(base + p, { waitUntil: 'load' });
    // Force the deferred GTM loader, then wait for the container to be ready
    // to run rather than for a fixed number of seconds. A slow gtm.js download
    // pushed every tag past a 3500ms sample, and the page printed clean for a
    // policy the same tag trips in a longer production session.
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.up();
    const ready = await page
      .waitForFunction(() => !!window.google_tag_manager, null, { timeout: GTM_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      unreachable.push(p);
    } else {
      // Tags fire on timers, on visibility and on interaction, so container
      // readiness is the start of the window and not the end of it.
      await page.waitForTimeout(SETTLE_MS);
      await exerciseFlows(page);
    }
    const fromEvents = await page.evaluate(() => window.__csp || []);
    const all = [...new Set([...fromEvents, ...seen])];
    // A block that is documented in csp.json is the policy working, not a
    // failure. Anything else is a real violation and fails the run.
    const unexpected = all.filter((v) => !EXPECTED.some((e) => v.includes(e.pattern)));
    const expected = all.filter((v) => EXPECTED.some((e) => v.includes(e.pattern)));
    if (unexpected.length) violations.push({ page: p, all: unexpected });
    const mark = unexpected.length ? '✗' : unreachable.includes(p) ? '?' : expected.length ? '~' : '✓';
    const note = unexpected.length ? ' — ' + unexpected.length + ' unexpected'
      : unreachable.includes(p) ? ' — GTM never became ready; nothing third-party was exercised'
      : expected.length ? ' — blocked as intended' : '';
    console.log(`${mark} ${p}${note}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (violations.length) {
  console.error('\nCSP VIOLATIONS:');
  for (const v of violations) {
    console.error(`  ${v.page}`);
    for (const line of v.all) console.error(`    - ${line}`);
  }
  process.exit(1);
}
// A page where the container never ran exercised no third-party code at all,
// so "no violations" there is a statement about nothing. Reported rather than
// swallowed, but not failed: the usual cause is a runner with no network, and
// turning that into a red build teaches people to ignore the red.
if (unreachable.length) {
  console.error(
    `\n${unreachable.length} page(s) where the GTM container never became ready within ${GTM_TIMEOUT_MS / 1000}s: ` +
    unreachable.join(', ') +
    '\nNo third-party code ran on them, so their clean result covers first-party requests only.'
  );
}
if (EXPECTED.length) {
  console.log('\nIntentionally blocked, documented in csp.json:');
  for (const e of EXPECTED) console.log(`  - ${e.pattern}`);
}
console.log(
  `\nCSP clean: ${pages.length - unreachable.length} of ${pages.length} pages fully exercised, no unexpected violations.`
);

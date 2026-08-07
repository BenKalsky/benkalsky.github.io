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
const vercelCfg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
const served = vercelCfg.headers
  .flatMap((r) => r.headers)
  .find((h) => h.key === 'Content-Security-Policy')?.value;
if (served !== CSP) {
  console.error('csp.json and vercel.json disagree. Production serves:\n  ' + (served ?? '(no CSP header)'));
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

const browser = await chromium.launch();
const violations = [];
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
    // Give the deferred GTM loader its idle window, then force it via a click.
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(3500);
    const fromEvents = await page.evaluate(() => window.__csp || []);
    const all = [...new Set([...fromEvents, ...seen])];
    // A block that is documented in csp.json is the policy working, not a
    // failure. Anything else is a real violation and fails the run.
    const unexpected = all.filter((v) => !EXPECTED.some((e) => v.includes(e.pattern)));
    const expected = all.filter((v) => EXPECTED.some((e) => v.includes(e.pattern)));
    if (unexpected.length) violations.push({ page: p, all: unexpected });
    const mark = unexpected.length ? '✗' : expected.length ? '~' : '✓';
    console.log(`${mark} ${p}${unexpected.length ? ' — ' + unexpected.length + ' unexpected' : expected.length ? ' — blocked as intended' : ''}`);
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
if (EXPECTED.length) {
  console.log('\nIntentionally blocked, documented in csp.json:');
  for (const e of EXPECTED) console.log(`  - ${e.pattern}`);
}
console.log(`\nCSP clean: ${pages.length} pages, no unexpected violations.`);

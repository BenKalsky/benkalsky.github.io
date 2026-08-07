// Accessibility gate: axe-core (WCAG 2.1 A+AA) over every built page.
// Pages are served over a local HTTP origin so root-relative assets
// (e.g. /_astro/*.css) resolve and style-dependent checks like
// color-contrast audit the real rendered page. Fails on any violation.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf-8');

const dist = path.resolve('dist');
const pages = [];
for await (const p of glob('**/*.html', { cwd: dist })) pages.push(p);
if (pages.length === 0) throw new Error('no built pages found — run astro build first');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist)) throw new Error('traversal');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// Checks axe could not decide, that a human has decided instead. Each was
// measured on 2026-08-07, when reporting `incomplete` was added and turned out
// to have been discarding a serious-impact check on every page since the gate
// was written. All are colour contrast, and all pass:
//
//   #consent-desc   #F7F6F2 on #12130F  = 17.25:1
//   .h1-mark        #12130F on #E8FF52  = 16.75:1
//   .stars          #12130F on #E8FF52  = 16.75:1
//
// AA asks 4.5:1. Axe cannot decide them because the elements sit over a
// backdrop it will not resolve, not because the contrast is marginal.
//
// This is an allowlist, not a filter: anything NOT on it fails. Printing the
// list and passing regardless was the previous version, and it would have let
// a new unresolved check hide inside a green build — nobody reads a passing
// log. Adding an entry here is a deliberate act that says someone measured it.
const REVIEWED = new Set([
  'color-contrast #consent-desc',
  'color-contrast .h1-mark',
  'color-contrast li:nth-child(1) > figure > .stars[role="img"][aria-label="חמישה כוכבים"]',
  'color-contrast li:nth-child(2) > figure > .stars[role="img"][aria-label="חמישה כוכבים"]',
  'color-contrast li:nth-child(3) > figure > .stars[role="img"][aria-label="חמישה כוכבים"]',
  'color-contrast li:nth-child(4) > figure > .stars[role="img"][aria-label="חמישה כוכבים"]',
]);

const browser = await chromium.launch();
let failed = false;
const needsReview = [];
const unreviewed = [];

try {
  const page = await browser.newPage();
  for (const rel of pages.sort()) {
    const route = '/' + (rel.endsWith('/index.html') || rel === 'index.html'
      ? rel.slice(0, -'index.html'.length)
      : rel);
    // goto() resolves for a 404 as readily as for a 200, and the local
    // handler's not-found body is a document axe finds nothing wrong with.
    // A route that stops mapping to a built file would have been logged clean
    // rather than reported missing.
    const response = await page.goto(origin + route, { waitUntil: 'networkidle' });
    const status = response?.status() ?? 0;
    if (status < 200 || status >= 300) {
      failed = true;
      console.error(`✗ ${route} — server answered ${status}; nothing was audited`);
      continue;
    }
    await page.evaluate(axeSource);
    const { violations, incomplete } = await page.evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      const shape = (v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      });
      return { violations: r.violations.map(shape), incomplete: r.incomplete.map(shape) };
    });
    if (violations.length) {
      failed = true;
      console.error(`✗ ${route}`);
      console.error(JSON.stringify(violations, null, 2));
    } else {
      console.log(`✓ ${route}${incomplete.length ? ` — ${incomplete.length} needing review` : ''}`);
    }
    // axe's "incomplete" is what it could not decide: a contrast check whose
    // effective background it cannot compute, an aria reference it cannot
    // resolve. Discarding them made a page with unresolved checks print the
    // same ✓ as one with none. They are surfaced and not failed — a human has
    // to look at each, and an automated gate cannot make that call — but a
    // gate that hides the question is worse than one that asks it.
    if (incomplete.length) {
      needsReview.push({ route, incomplete });
      for (const i of incomplete) {
        for (const n of i.nodes) {
          if (!REVIEWED.has(`${i.id} ${n}`)) unreviewed.push(`${route} — ${i.id} on ${n}`);
        }
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (needsReview.length) {
  const total = needsReview.reduce((n, r) => n + r.incomplete.length, 0);
  console.log(`\n${total} check(s) axe could not decide, across ${needsReview.length} page(s):`);
  for (const { route, incomplete } of needsReview) {
    for (const i of incomplete) {
      console.log(`  ? ${route} — ${i.id} (${i.impact ?? 'no impact rating'}): ${i.help}`);
      for (const n of i.nodes) console.log(`      ${n}`);
    }
  }
  console.log('Each of these is on the reviewed list in this file, or the run fails below.');
}
if (unreviewed.length) {
  failed = true;
  console.error(`\n${unreviewed.length} unresolved check(s) that nobody has measured:`);
  for (const u of unreviewed) console.error('  \u2717 ' + u);
  console.error(
    'Measure each, then add "<rule-id> <selector>" to REVIEWED at the top of this file.\n' +
    'Printing them and passing anyway is what hid a serious-impact contrast check on\n' +
    'every page for as long as this gate has existed.'
  );
}
if (failed) process.exit(1);
console.log(`\naxe clean: ${pages.length} pages, no violations${needsReview.length ? `, ${needsReview.length} page(s) with checks needing review` : ''}`);

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

const browser = await chromium.launch();
let failed = false;

try {
  const page = await browser.newPage();
  for (const rel of pages.sort()) {
    const route = '/' + (rel.endsWith('/index.html') || rel === 'index.html'
      ? rel.slice(0, -'index.html'.length)
      : rel);
    await page.goto(origin + route, { waitUntil: 'networkidle' });
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      }));
    });
    if (violations.length) {
      failed = true;
      console.error(`✗ ${route}`);
      console.error(JSON.stringify(violations, null, 2));
    } else {
      console.log(`✓ ${route}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
console.log(`axe clean: ${pages.length} pages`);

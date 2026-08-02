// Accessibility gate: axe-core (WCAG 2.1 A+AA) over every built page.
// Fails the build on any violation.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { glob } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf-8');

const dist = path.resolve('dist');
const pages = [];
for await (const p of glob('**/index.html', { cwd: dist })) pages.push(p);
if (pages.length === 0) throw new Error('no built pages found — run astro build first');

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;

for (const rel of pages.sort()) {
  await page.goto('file://' + path.join(dist, rel), { waitUntil: 'load' });
  await page.waitForTimeout(400);
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
    console.error(`✗ /${rel}`);
    console.error(JSON.stringify(violations, null, 2));
  } else {
    console.log(`✓ /${rel}`);
  }
}

await browser.close();
if (failed) process.exit(1);
console.log(`axe clean: ${pages.length} pages`);

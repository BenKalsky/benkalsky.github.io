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

// Checks axe could not decide, that a human has decided instead. Measured
// 2026-08-07, when reporting `incomplete` was added and turned out to have
// been discarding a serious-impact check on every page since this gate was
// written. All are colour contrast, and all pass — AA asks 4.5:1:
//
//   rgb(247,246,242) on rgb(18,19,15)    17.25:1   #consent-desc
//   rgb(232,255,82)  on rgb(18,19,15)    16.75:1   .fit-yes marks
//   rgb(18,19,15)    on rgb(232,255,82)  16.75:1   .h1-mark, .stars
//   rgb(85,86,77)    on rgb(247,246,242)  6.88:1   .fit-no marks
//
// Axe cannot decide them because the elements sit over a backdrop it will not
// resolve, not because the contrast is marginal.
//
// Keyed on the RULE and the RENDERED COLOURS, not on the selector. Two reasons,
// and they pull the same way:
//
//   - A key of rule + selector survives a CSS change. .h1-mark could drop
//     below 4.5:1 and, as long as axe still could not resolve its background,
//     the stale approval would match and the gate would stay green. A colour
//     that changes produces a key nobody has approved.
//   - The selectors axe reports are positional — li:nth-child(3) > figure >
//     .stars — so reordering the testimonials would have failed the build for
//     no real reason. The colours do not move when the markup does.
//
// This is an allowlist, not a filter: anything NOT on it fails. Printing the
// list and passing regardless was the previous version, and it would have let
// a new unresolved check hide inside a green build — nobody reads a passing
// log. Adding an entry here is a deliberate act that says someone measured it.
const REVIEWED = new Set([
  'color-contrast rgb(247, 246, 242) on rgb(18, 19, 15)',
  'color-contrast rgb(232, 255, 82) on rgb(18, 19, 15)',
  'color-contrast rgb(18, 19, 15) on rgb(232, 255, 82)',
  'color-contrast rgb(85, 86, 77) on rgb(247, 246, 242)',
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
      // Finish every finite animation first. The entrance animations are
      // opacity fades, and networkidle does not wait for them — the first run
      // of the compositing fingerprint caught one mid-flight at
      // opacity: 0.988073, which would have made the key different on every
      // run and the allowlist useless. Infinite animations (the logo marquee,
      // the hero blob) are left alone: they never finish, and they do not
      // change any measured colour.
      for (const a of document.getAnimations()) {
        try {
          if (a.effect?.getTiming?.().iterations !== Infinity) a.finish();
        } catch (e) { /* an animation that cannot be finished is left running */ }
      }
      const r = await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      // The rendered colours of a node, so an approval can be tied to what was
      // actually measured. A key of rule + selector alone survives a CSS
      // change: .h1-mark could drop below 4.5:1 and, as long as axe still
      // cannot resolve its background, the old approval would still match.
      // Resolved from the selector, not from n.element: axe's node objects
      // carry a live element reference that does not survive being returned
      // out of the page, so reading it here produced "unknown" for every node
      // and the fingerprint would have been a constant.
      // Compositing is part of the fingerprint, not just the two colours.
      // Adding opacity to the element or any ancestor, or a background-image
      // that keeps the same fallback colour, changes the pixels a browser
      // actually paints while leaving color and backgroundColor identical —
      // so an approval keyed on the pair alone would survive it.
      const colours = (selector) => {
        try {
          const el = document.querySelector(selector);
          if (!el) return 'not found';
          const cs = getComputedStyle(el);
          let node = el, bg = 'rgba(0, 0, 0, 0)';
          const layers = [];
          while (node) {
            const ns = getComputedStyle(node);
            if (ns.opacity !== '1') layers.push(`opacity:${ns.opacity}`);
            if (ns.backgroundImage !== 'none') layers.push('bg-image');
            if (ns.mixBlendMode !== 'normal') layers.push(`blend:${ns.mixBlendMode}`);
            if (ns.filter !== 'none') layers.push('filter');
            if (bg === 'rgba(0, 0, 0, 0)') bg = ns.backgroundColor;
            node = node.parentElement;
          }
          const composite = layers.length ? ` +${[...new Set(layers)].sort().join('+')}` : '';
          return `${cs.color} on ${bg}${composite}`;
        } catch (e) { return 'unreadable'; }
      };
      // No slice for the gate. Truncating to five before the allowlist ran
      // meant a rule with six unresolved nodes had its sixth neither printed
      // nor required to match — and the homepage contrast set has exactly six.
      const shape = (v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({
          target: n.target.join(' '),
          colours: colours(n.target[0]),
        })),
      });
      return { violations: r.violations.map(shape), incomplete: r.incomplete.map(shape) };
    });
    // WCAG 2.2.2, and the sentence the accessibility statement makes about it:
    // continuous motion exists on the homepage only, and one control stops all
    // of it. axe cannot check that — it does not know which button pauses what
    // — and the statement was wrong once already, promising a pause for all
    // moving content while the only control paused the logo strip and left the
    // hero blob drifting. A claim only a measurement can keep true belongs in
    // the gate that runs on every build, not in a comment.
    //
    // Runs after axe, because it clicks.
    const motion = await page.evaluate(async () => {
      const infinite = () => document.getAnimations()
        .filter((a) => a.effect?.getTiming?.().iterations === Infinity);
      const running = infinite();
      if (!running.length) return { count: 0 };
      const control = document.querySelector('[data-motion-pause]');
      if (!control) return { count: running.length, control: false };
      control.click();
      // A class toggle repaints before the animation's playState settles.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const stillRunning = infinite().filter((a) => a.playState !== 'paused').length;
      return { count: running.length, control: true, stillRunning };
    });
    if (motion.count && !motion.control) {
      failed = true;
      console.error(
        `✗ ${route} — ${motion.count} animation(s) never end and the page has no ` +
        `[data-motion-pause] control; the accessibility statement promises one`
      );
    } else if (motion.stillRunning) {
      failed = true;
      console.error(
        `✗ ${route} — the pause control left ${motion.stillRunning} of ${motion.count} ` +
        `endless animation(s) running; the control paused some of the motion, not all of it`
      );
    }
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
          const key = `${i.id} ${n.colours}`;
          if (!REVIEWED.has(key)) unreviewed.push(`${route} — ${key}  (at ${n.target})`);
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
      for (const n of i.nodes) console.log(`      ${n.target}  [${n.colours}]`);
    }
  }
  console.log('Each of these is on the reviewed list in this file, or the run fails below.');
}
if (unreviewed.length) {
  failed = true;
  console.error(`\n${unreviewed.length} unresolved check(s) that nobody has measured:`);
  for (const u of unreviewed) console.error('  \u2717 ' + u);
  console.error(
    'Measure each, then add "<rule-id> <colours>" to REVIEWED at the top of this file.\n' +
    'Printing them and passing anyway is what hid a serious-impact contrast check on\n' +
    'every page for as long as this gate has existed.'
  );
}
if (failed) process.exit(1);
console.log(`\naxe clean: ${pages.length} pages, no violations${needsReview.length ? `, ${needsReview.length} page(s) with checks needing review` : ''}`);

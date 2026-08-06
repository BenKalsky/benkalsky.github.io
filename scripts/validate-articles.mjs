// Enforces the article standard from SEO-PLAN.md against the built output.
//
// Every rule here exists because it was missed or nearly missed by hand:
// title length was wrong twice in one session, and two headings that would
// have cannibalised existing articles were caught by a manual grep that
// nobody is obliged to remember to run. This turns that memory into a gate.
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';

const DIST = path.resolve(process.cwd(), 'dist');
const SITE = 'https://www.benkalsky.co.il';

const LIMITS = {
  titleMin: 50, titleMax: 60,
  descMin: 120, descMax: 150,
  minWords: 700,
  minH2: 5,
  minFaq: 5,
};
// Any of these in the description counts as a call to action.
const CTA_WORDS = ['קבעו', 'קבע', 'צרו קשר', 'דברו', 'השאירו', 'בואו'];

const problems = [];
const flag = (file, msg) => problems.push(`${file}: ${msg}`);

// Collect every built page first — heading collisions need the whole corpus.
const pages = new Map();
for await (const rel of glob('**/*.html', { cwd: DIST })) {
  pages.set('/' + rel.replace(/index\.html$/, ''), readFileSync(path.join(DIST, rel), 'utf8'));
}

const articlePaths = [...pages.keys()].filter((p) => p.startsWith('/blog/') && p !== '/blog/');
if (!articlePaths.length) {
  console.error('no articles found in dist/ — did the build run?');
  process.exit(1);
}

// Headings per page, so a new article can be compared against every other one.
const headingsByPage = new Map();
for (const [p, html] of pages) {
  const $ = load(html);
  headingsByPage.set(p, $('main h2').map((_, el) => $(el).text().trim()).get());
}
// "שאלות ותשובות" and the CTA heading are shared by design.
const SHARED_HEADINGS = new Set(['שאלות ותשובות']);

for (const p of articlePaths) {
  const html = pages.get(p);
  const $ = load(html);
  const main = $('article.prose');

  // --- head ---
  const title = $('head > title').text();
  if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) {
    flag(p, `title is ${title.length} chars, must be ${LIMITS.titleMin}-${LIMITS.titleMax}`);
  }
  const desc = $('meta[name="description"]').attr('content') ?? '';
  if (desc.length < LIMITS.descMin || desc.length > LIMITS.descMax) {
    flag(p, `description is ${desc.length} chars, must be ${LIMITS.descMin}-${LIMITS.descMax}`);
  }
  if (!CTA_WORDS.some((w) => desc.includes(w))) flag(p, 'description has no call to action');
  if ($('link[rel="canonical"]').attr('href') !== SITE + p) flag(p, 'canonical does not match the page path');
  if (!$('meta[property="og:image"]').attr('content')) flag(p, 'no og:image');

  // --- structure ---
  const h1 = main.find('h1');
  if (h1.length !== 1) flag(p, `${h1.length} h1 elements, must be exactly 1`);
  const h2s = main.find('h2').map((_, el) => $(el).text().trim()).get();
  if (h2s.length < LIMITS.minH2) flag(p, `${h2s.length} h2 headings, minimum ${LIMITS.minH2}`);

  // --- body ---
  const body = main.clone();
  body.find('script, style').remove();
  const text = body.text().replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean).length;
  if (words < LIMITS.minWords) flag(p, `${words} words, minimum ${LIMITS.minWords}`);
  if (text.includes('—')) flag(p, 'em-dash in Hebrew body copy');
  if (/\bסיכום\b/.test(text)) flag(p, 'uses "סיכום" as a section');

  // --- Q&A and schema ---
  const qa = main.find('.qa details').length;
  if (qa < LIMITS.minFaq) flag(p, `${qa} Q&A entries, minimum ${LIMITS.minFaq}`);
  const ld = $('script[type="application/ld+json"]').map((_, el) => $(el).html()).get().join('');
  let graph = [];
  try {
    for (const raw of $('script[type="application/ld+json"]').map((_, el) => $(el).html()).get()) {
      const parsed = JSON.parse(raw);
      graph = graph.concat(parsed['@graph'] ?? [parsed]);
    }
  } catch { flag(p, 'structured data is not valid JSON'); }
  const types = graph.map((n) => n['@type']);
  for (const t of ['Article', 'FAQPage', 'Person', 'Organization']) {
    if (!types.includes(t)) flag(p, `structured data missing ${t}`);
  }
  const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
  if (faqNode && faqNode.mainEntity.length !== qa) {
    flag(p, `FAQPage lists ${faqNode.mainEntity.length} questions but the page renders ${qa}`);
  }

  // --- dates must agree, and come from meta ---
  const articleNode = graph.find((n) => n['@type'] === 'Article');
  const visible = main.find('time[datetime]').attr('datetime');
  if (articleNode && visible && articleNode.datePublished !== visible) {
    flag(p, `visible date ${visible} disagrees with schema datePublished ${articleNode.datePublished}`);
  }

  // --- internal links must resolve ---
  main.find('a[href^="/"]').each((_, el) => {
    const href = $(el).attr('href').split('#')[0];
    if (href && !pages.has(href)) flag(p, `internal link ${href} does not exist in the build`);
  });

  // --- cannibalisation: a heading may not repeat another article's ---
  for (const h of h2s) {
    if (SHARED_HEADINGS.has(h) || h.endsWith('?')) continue;
    for (const [other, otherHeadings] of headingsByPage) {
      if (other === p) continue;
      if (otherHeadings.includes(h)) flag(p, `h2 "${h}" also appears on ${other}`);
    }
  }
}

console.log(`checked ${articlePaths.length} articles`);
if (problems.length) {
  console.error('\nARTICLE STANDARD VIOLATIONS:');
  for (const pr of problems) console.error('  ✗ ' + pr);
  process.exit(1);
}
console.log('all articles meet the standard in SEO-PLAN.md');

// Enforces the article standard against the built output. The standard itself
// lives in the marketing repo, Digitizers/digitizer-cmo, at
// method/page-standards.md — SEO-PLAN.md here is only a pointer at it.
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
//
// Matched with letter boundaries rather than by substring: `includes('קבע')`
// is satisfied by `המחיר נקבע לפי`, which asks the reader to do nothing.
// JavaScript's \b is defined over ASCII word characters and creates no
// boundary at all next to a Hebrew letter, so the boundary has to be spelled
// out as "not preceded or followed by a letter".
const CTA_WORDS = ['קבעו', 'קבע', 'צרו קשר', 'דברו', 'השאירו', 'בואו'];
const CTA_PATTERNS = CTA_WORDS.map(
  (w) => new RegExp(`(?<!\\p{L})${w.replace(/ /g, '\\s+')}(?!\\p{L})`, 'u')
);

// Headings that a page may not use, compared against the headings themselves.
// This was written as /\bסיכום\b/ over the body text, which never matches:
// \b needs an ASCII word character on one side, and Hebrew has none. The rule
// was dead from the day it was written.
const FORBIDDEN_HEADINGS = new Set(['סיכום', 'לסיכום', 'סיכום ומסקנות']);

// Bidi controls are invisible and legitimate in mixed Hebrew/LTR text, and
// they break every comparison and count they touch: two headings that render
// identically differ by an RLM, and a title is one "character" longer than it
// looks. Stripped before anything is compared or measured.
const BIDI = /[‎‏؜‪-‮⁦-⁩﻿]/g;
const norm = (s) => String(s ?? '').normalize('NFC').replace(BIDI, '').replace(/\s+/g, ' ').trim();

// String.length counts UTF-16 code units. An emoji counts as two, and the
// limits here are stated in characters someone can see.
const segmenter = new Intl.Segmenter('he', { granularity: 'grapheme' });
const visibleLength = (s) => [...segmenter.segment(norm(s))].length;

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

// Headings per ARTICLE, so a new article can be compared against every other
// one. Built from articlePaths rather than from every built page: the check is
// about two articles competing for the same query, and the homepage and the
// blog index compete with neither. Indexing them made a generic homepage h2
// reject a legitimate article heading as cannibalisation.
const headingsByArticle = new Map();
for (const p of articlePaths) {
  const $ = load(pages.get(p));
  headingsByArticle.set(p, $('article.prose h2').map((_, el) => norm($(el).text())).get());
}
// "שאלות ותשובות" is shared by design. The CTA heading is shared too, but it
// is identified by the block it lives in rather than by its shape — exempting
// every heading that ends in "?" let two articles ship the same content
// heading as long as it was phrased as a question.
const SHARED_HEADINGS = new Set(['שאלות ותשובות']);

for (const p of articlePaths) {
  const html = pages.get(p);
  const $ = load(html);
  const main = $('article.prose');

  // --- head ---
  const title = $('head > title').text();
  const titleLen = visibleLength(title);
  if (titleLen < LIMITS.titleMin || titleLen > LIMITS.titleMax) {
    flag(p, `title is ${titleLen} chars, must be ${LIMITS.titleMin}-${LIMITS.titleMax}`);
  }
  const desc = $('meta[name="description"]').attr('content') ?? '';
  const descLen = visibleLength(desc);
  if (descLen < LIMITS.descMin || descLen > LIMITS.descMax) {
    flag(p, `description is ${descLen} chars, must be ${LIMITS.descMin}-${LIMITS.descMax}`);
  }
  if (!CTA_PATTERNS.some((re) => re.test(norm(desc)))) flag(p, 'description has no call to action');
  if ($('link[rel="canonical"]').attr('href') !== SITE + p) flag(p, 'canonical does not match the page path');
  if (!$('meta[property="og:image"]').attr('content')) flag(p, 'no og:image');

  // --- structure ---
  const h1 = main.find('h1');
  if (h1.length !== 1) flag(p, `${h1.length} h1 elements, must be exactly 1`);
  const h2s = main.find('h2').map((_, el) => norm($(el).text())).get();
  if (h2s.length < LIMITS.minH2) flag(p, `${h2s.length} h2 headings, minimum ${LIMITS.minH2}`);
  // Headings inside the closing CTA block are shared across every article on
  // purpose, and are exempt from the cannibalisation check below.
  const ctaHeadings = new Set(main.find('.post-cta h2').map((_, el) => norm($(el).text())).get());
  const forbidden = h2s.filter((h) => FORBIDDEN_HEADINGS.has(h));
  if (forbidden.length) flag(p, `heading "${forbidden[0]}" is not permitted as a section`);

  // --- body ---
  const body = main.clone();
  body.find('script, style').remove();
  const text = body.text().replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean).length;
  if (words < LIMITS.minWords) flag(p, `${words} words, minimum ${LIMITS.minWords}`);
  if (text.includes('—')) flag(p, 'em-dash in Hebrew body copy');

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

  // --- the Article must be attributed to Ben, not merely accompanied by him ---
  // Checking that an Article node and a Person node both exist proves nothing
  // about the edge between them: an article with no author, the wrong author,
  // or a Person nobody points at satisfied that.
  const articleNode = graph.find((n) => n['@type'] === 'Article');
  const personNode = graph.find((n) => n['@type'] === 'Person');
  if (articleNode && personNode) {
    const ref = articleNode.author;
    const authorId = typeof ref === 'string' ? ref : ref?.['@id'];
    if (!ref) {
      flag(p, 'Article has no author');
    } else if (!authorId) {
      flag(p, `Article author is inline rather than a reference: ${JSON.stringify(ref).slice(0, 80)}`);
    } else if (authorId !== personNode['@id']) {
      flag(p, `Article author ${authorId} does not resolve to the Person node ${personNode['@id']}`);
    }
  }

  // --- dates must agree, and both must be there ---
  // Running the comparison only when both are present meant deleting either
  // one silently satisfied the rule.
  const visible = main.find('time[datetime]').attr('datetime');
  if (!articleNode?.datePublished) flag(p, 'Article has no datePublished');
  if (!visible) flag(p, 'no visible <time datetime> in the article');
  if (articleNode?.datePublished && visible && articleNode.datePublished !== visible) {
    flag(p, `visible date ${visible} disagrees with schema datePublished ${articleNode.datePublished}`);
  }

  // --- internal links must resolve ---
  main.find('a[href^="/"]').each((_, el) => {
    const href = $(el).attr('href').split('#')[0];
    if (href && !pages.has(href)) flag(p, `internal link ${href} does not exist in the build`);
  });

  // --- cannibalisation: a heading may not repeat another article's ---
  // Both sides are normalised, so an invisible RLM or a doubled space cannot
  // make two headings that render identically compare as different.
  for (const h of h2s) {
    if (SHARED_HEADINGS.has(h) || ctaHeadings.has(h)) continue;
    for (const [other, otherHeadings] of headingsByArticle) {
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
console.log('all articles meet the standard in digitizer-cmo/method/page-standards.md');

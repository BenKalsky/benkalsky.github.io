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
// The site owner's node, by ID. Ben decided on 2026-08-08 that he is the
// publisher, which is what /terms/ and /privacy/ have always said, and this
// is the identity both the author and the publisher edge must resolve to.
const BEN_ID = `${SITE}/#ben`;

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
//
// U+206A–U+206F are deprecated and nothing emits them on purpose, which is
// exactly why they are here: a stray one survives a hand-written class that
// only covers the marks someone thought of, and Intl.Segmenter counts each as
// its own grapheme. Verified — U+206A passed the earlier class and added one
// to every length it touched.
const BIDI = /[‎‏؜‪-‮⁦-⁩⁪-⁯﻿]/g;
const norm = (s) => String(s ?? '').normalize('NFC').replace(BIDI, '').replace(/\s+/g, ' ').trim();

// The four destinations an article actually closes on. Matched by parsed URL,
// not by substring: `digitizer.li` alone would accept /cw-spotlight, which
// this repo already links to and which is a resource rather than a way to
// reach anyone, and an unanchored /#contact/ would accept another site's
// fragment. See closing-cta in digitizer-cmo/method/page-standards.md.
const CONTACT_HOSTS = new Set(['wa.me', 'www.wa.me']);
const BOOKING = { host: 'digitizer.li', path: '/schedule' };
const SITE_HOSTS = new Set(['www.benkalsky.co.il', 'benkalsky.co.il']);
function isContactHref(href) {
  if (typeof href !== 'string' || !href) return false;
  if (href.startsWith('mailto:') || href.startsWith('tel:')) return true;
  let u;
  try { u = new URL(href, SITE + '/'); } catch { return false; }
  if (u.hash === '#contact' && SITE_HOSTS.has(u.hostname)) return true;
  if (CONTACT_HOSTS.has(u.hostname)) return true;
  return u.hostname.replace(/^www\./, '') === BOOKING.host && u.pathname.replace(/\/$/, '') === BOOKING.path;
}

// Text that follows an element in document order, walking up the ancestor
// chain so a link nested in a closing block still sees what comes after that
// block.
//
// contents() rather than nextAll(): nextAll returns element siblings only, so
// a bare text node after the link is invisible to it — and the closing line in
// .cta-line articles is exactly that, "…חינם" inside the link and
// "ונראה מאיפה מתחילים." as a text node after it. Measured with nextAll,
// every article reported zero trailing characters, which was the function
// failing to see rather than the articles closing cleanly.
// Returns the trailing text and any ELEMENTS that follow, separately.
//
// A character count alone is not the assertion: an element with no text —
// a figure, a video, an iframe, an image gallery — follows the CTA while
// contributing nothing to the count, and a short heading fits under any
// threshold worth setting. What "closes the article" means is that nothing
// substantive comes after, and an element is substantive whether or not it
// says anything.
// Phrasing content, which the closing sentence is allowed to use. The rule is
// about what comes after the article ends, and "<a>קבעו פגישה</a><strong>
// ונראה מאיפה מתחילים</strong>" is the same closing line as the bare text node
// the corpus happens to use today — the difference is a tag, not a section.
// Everything outside this set counts, whether or not it says anything.
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em',
  'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub',
  'sup', 'time', 'u', 'var', 'wbr',
]);
function contentAfter($, el, root) {
  let text = '';
  const els = [];
  let node = el;
  while (node.length && !node.is(root)) {
    const siblings = node.parent().contents().toArray();
    for (const s of siblings.slice(siblings.indexOf(node[0]) + 1)) {
      text += ' ' + $(s).text();
      if (s.type !== 'tag') continue;
      // The wrapper's own tag is not the whole answer. "<span><img></span>"
      // contributes no text and its outermost tag is phrasing content, so
      // checking the sibling alone accepted an arbitrarily large media block
      // as the end of the article. Descendants are checked too, so an allowed
      // wrapper cannot smuggle a disallowed element through.
      if (!INLINE.has(s.name)) els.push(s.name);
      for (const d of $(s).find('*').toArray()) {
        if (!INLINE.has(d.name)) els.push(d.name);
      }
    }
    node = node.parent();
  }
  return { text, els };
}
// Bare text after the link is the closing half-sentence in .cta-line
// articles — "…ונראה מאיפה מתחילים." — and nothing else. Measured across the
// nine live articles: longest 20 characters, and ZERO elements after the link
// in every one of them. So elements are forbidden outright and the text
// allowance is small and evidenced rather than guessed. An earlier guess of
// 120 let a whole added paragraph through in testing.
const MAX_TRAILING_AFTER_CTA = 40;

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
// "שאלות ותשובות" is shared by design and is the only heading that is.
//
// There was an exemption for the closing CTA heading too — first every
// heading ending in "?", then every heading inside .post-cta. Measured
// 2026-08-07: all seven CTA headings in the corpus are DIFFERENT from each
// other. The exemption never protected anything, and each version of it was a
// hole: the first let two articles ship the same question-form content
// heading, the second would have exempted every heading in an article wrapped
// in one container. Removed rather than narrowed.
const SHARED_HEADINGS = new Set(['שאלות ותשובות']);

// The head phrase of a <title>: everything before the first punctuation that
// separates the claim from its elaboration. That leading phrase is what a
// search result leads with and what the page is asking to own.
//
// Two live articles led with the same one — /blog/ai-agents/ and
// /blog/build-ai-agent/ both opened "סוכן AI לעסק:" — while only the second
// has that string assigned to it in the registry. The h2 collision check
// could not see it, because it never looked at titles, and the pair shipped
// on 2026-08-02 and 06.08 without anything complaining.
//
// The corpus splits on a mix of ":", "?" and "," today, which is why all four
// are separators here rather than a single one: keying on ":" alone would
// compare whole titles for four of the nine articles and never collide.
const headPhrase = (title) => norm(title.split('|')[0].split(/[:?,]/)[0]);
const titlesByArticle = new Map();
for (const p of articlePaths) {
  titlesByArticle.set(p, headPhrase(load(pages.get(p))('head > title').text()));
}

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
  // Every article must END by asking the reader to do something.
  //
  // Deliberately not "contains .post-cta or .cta-line". Those are the two
  // shapes in today's corpus, and a gate that names them rejects a third
  // rendering that closes just as well — while a class appearing anywhere,
  // including mid-body, satisfied it and exempted its headings from the
  // collision check. Both are the same mistake: describing the markup instead
  // of the requirement.
  //
  // What is asserted is the requirement: the reader can act at the point they
  // stop reading. Tested as "the last actionable link has almost nothing after
  // it" rather than "the last child element contains one", because an article
  // wrapped in a single container has exactly one child and any link anywhere
  // inside it would satisfy that. Position is the whole requirement, so
  // position is what is measured.
  const actionable = main.find('a[href]').toArray().filter((el) => isContactHref($(el).attr('href')));
  if (!actionable.length) {
    flag(p, 'the article has no way to get in touch');
  } else {
    const after = contentAfter($, $(actionable[actionable.length - 1]), main);
    if (after.els.length) {
      flag(p, `<${after.els.join('>, <')}> follow${after.els.length === 1 ? 's' : ''} the last way to get in touch — it does not close the article`);
    }
    const trailing = norm(after.text);
    if (trailing.length > MAX_TRAILING_AFTER_CTA) {
      flag(p, `${trailing.length} characters of content follow the last way to get in touch — it does not close the article`);
    }
  }
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

    // The publisher is the same kind of edge and was pointing somewhere else.
    // Every article named Digitizer as publisher while /terms/ says the content
    // belongs to the site owner and /privacy/ says the site is operated by Ben
    // — structured data contradicting the site's own legal pages, on nine
    // pages, for as long as the blog has existed. Ben's decision, 2026-08-08:
    // he is the publisher. Enforced here so the next article cannot quietly
    // reintroduce the other answer. Digitizer stays in the graph where it is
    // true, as the Person's worksFor.
    //
    // Compared against the stable ID and not against whichever Person node the
    // graph happens to contain. An article that defines a different Person and
    // points both author and publisher at it satisfies "publisher matches the
    // Person node" completely — the invariant is that the publisher is Ben,
    // not that the graph is internally tidy. The Person node is checked against
    // the same ID for the same reason.
    const pubRef = articleNode.publisher;
    const publisherId = typeof pubRef === 'string' ? pubRef : pubRef?.['@id'];
    if (!pubRef) {
      flag(p, 'Article has no publisher');
    } else if (publisherId !== BEN_ID) {
      flag(p, `Article publisher ${publisherId} is not ${BEN_ID} — /terms/ gives the content to the site owner`);
    }
    if (personNode['@id'] !== BEN_ID) {
      flag(p, `the Person node is ${personNode['@id']}, not ${BEN_ID}`);
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
  // dateModified was mapped to datePublished, so every article told crawlers it
  // had never been touched — including the nine revised on 2026-08-08 to
  // correct claims that were not true. A modification date that cannot move is
  // not a modification date. It may equal datePublished, and it may not precede
  // it.
  const modified = articleNode?.dateModified;
  if (!modified) {
    flag(p, 'Article has no dateModified');
  } else if (articleNode.datePublished && modified < articleNode.datePublished) {
    flag(p, `dateModified ${modified} precedes datePublished ${articleNode.datePublished}`);
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
    if (SHARED_HEADINGS.has(h)) continue;
    for (const [other, otherHeadings] of headingsByArticle) {
      if (other === p) continue;
      if (otherHeadings.includes(h)) flag(p, `h2 "${h}" also appears on ${other}`);
    }
  }

  // --- cannibalisation: two titles may not lead with the same phrase ---
  const head = titlesByArticle.get(p);
  for (const [other, otherHead] of titlesByArticle) {
    if (other === p) continue;
    if (otherHead === head) {
      flag(p, `title leads with "${head}", and so does ${other} — both pages ask to own it`);
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

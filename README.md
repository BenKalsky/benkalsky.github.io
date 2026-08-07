# benkalsky.co.il

[![Page checks](https://github.com/BenKalsky/benkalsky.co.il/actions/workflows/a11y.yml/badge.svg)](https://github.com/BenKalsky/benkalsky.co.il/actions/workflows/a11y.yml)

**[www.benkalsky.co.il](https://www.benkalsky.co.il)** — personal site of Ben Kalsky, co-founder & CTO at [Digitizer](https://www.digitizer.co.il). A Hebrew (RTL) landing page and blog about putting AI to work in real businesses: agents, MCP, automations and agentic development.

Built end-to-end with an agentic workflow — [Claude Code](https://claude.com/claude-code) develops, a second AI reviewer audits every pull request, a human merges. The site practices what its content preaches.

## Architecture

| Piece | How |
| --- | --- |
| Homepage | Hand-crafted static `public/index.html`, passed through the build byte-for-byte |
| Blog | [Astro](https://astro.build) static build (`src/pages/blog/`), shared RTL layout, auto sitemap |
| Hosting | Vercel, deployed from `master`, with the contact function in the same project |
| Contact form | Vercel serverless function (`api/contact.js`) relaying via ElasticEmail, with honeypot + rate limiting |
| Analytics | GTM + GA4 behind Google Consent Mode v2 (denied by default, Hebrew consent banner); the container loads off the critical path, on first interaction or browser idle |
| Fonts | Greycliff Hebrew CF, self-hosted and licensed — not for reuse |

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # static build into dist/
```

**Invariant:** the homepage must survive the build untouched. After any change:

```bash
cmp dist/index.html public/index.html   # must be silent
```

## Hosting and the trailing-slash contract

`vercel.json` sets `trailingSlash: true`. Astro builds with `format: 'directory'`, so every canonical URL on the site ends in a slash; without this setting each one would become a 308 redirect target.

**It applies to `/api` as well, and there is no per-path override.** A request to `/api/contact` is 308-redirected to `/api/contact/`. That matters more than it looks: browsers do not follow redirects on a CORS preflight, so a cross-origin form posting to the unslashed path fails outright rather than degrading.

**Always call the API at `/api/contact/`, with the slash.** Verified against a real deployment: the slashed path returns 204 on preflight, 200 on the honeypot path, 400 on validation failure and 403 on a disallowed origin, while every one of those returns 308 without the slash.

The function accepts one origin, `https://www.benkalsky.co.il`. Browsers do send `Origin` on a same-origin POST — verified on both Chromium and WebKit, so Safari is covered — which is what makes a one-constant check sufficient after the CORS layer was removed.

**A consequence: the contact form returns 403 on every preview deployment**, because a preview's origin is never the production one. That is correct behaviour, not a regression. Do not widen the check to make previews convenient.

## Content Security Policy

The policy lives in `csp.json`, is served from `vercel.json`, and is proven by `npm run verify:csp` — which loads every built page in a real browser, collects `securitypolicyviolation` events, and fails on anything not documented as intentionally blocked. It also fails if `csp.json` and `vercel.json` have drifted, since otherwise it would be proving a policy nobody serves.

`script-src` carries `'unsafe-inline'`. The site has 44 inline script blocks and GTM injects more at runtime, so the honest description is that this policy stops external script injection, framing, plugins, form redirection and base-tag hijacking — **not inline XSS.** Tightening it means hashes plus `strict-dynamic` and a build step to keep the hashes current; worth doing, but it is a project rather than a config line.

Writing this policy is what found a GTM-injected Meta Pixel setting an `_fbp` advertising cookie before consent, on every page, while the privacy policy stated no advertising use and listed no Meta processor. Consent Mode v2 gates Google tags automatically and third-party tags not at all. The tag was removed from the container rather than allowlisted here.

## Conventions

- Every change lands through a pull request and an AI code-review loop; merges happen only on a clean review of the branch head.
- Blog content follows the standards in the marketing repo, `Digitizers/digitizer-cmo`: page standards in `method/page-standards.md`, keyword ownership in `keywords/registry.md`, and this site's plan in `sites/benkalsky.co.il/plan.md`. [SEO-PLAN.md](SEO-PLAN.md) here is a pointer at them. Each article ships with Article + FAQPage structured data.
- Conversion tracking is documented in [TRACKING.md](TRACKING.md) — three events, no personal data in any of them.

## Privacy

The contact form ships with an Israeli Privacy Protection Law (Amendment 13) disclosure. Analytics run under Google Consent Mode v2: all storage stays denied until the visitor opts in via the consent banner — before that, GA4 receives only cookieless, unidentified pings (see [TRACKING.md](TRACKING.md)). Form submissions are relayed by ElasticEmail; the API key lives in a Vercel environment variable, never in this repo.

---

© Ben Kalsky. Code is public for transparency; content, branding and licensed fonts are not for reuse.

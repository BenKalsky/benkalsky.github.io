# benkalsky.co.il

[![Deploy](https://github.com/BenKalsky/benkalsky.github.io/actions/workflows/deploy.yml/badge.svg)](https://github.com/BenKalsky/benkalsky.github.io/actions/workflows/deploy.yml)

**[www.benkalsky.co.il](https://www.benkalsky.co.il)** — personal site of Ben Kalsky, co-founder & CTO at [Digitizer](https://www.digitizer.co.il). A Hebrew (RTL) landing page and blog about putting AI to work in real businesses: agents, MCP, automations and agentic development.

Built end-to-end with an agentic workflow — [Claude Code](https://claude.com/claude-code) develops, a second AI reviewer audits every pull request, a human merges. The site practices what its content preaches.

## Architecture

| Piece | How |
| --- | --- |
| Homepage | Hand-crafted static `public/index.html`, passed through the build byte-for-byte |
| Blog | [Astro](https://astro.build) static build (`src/pages/blog/`), shared RTL layout, auto sitemap |
| Hosting | GitHub Pages behind a custom domain, deployed by GitHub Actions on every push to `master` |
| Contact form | Vercel serverless function (`contact-api/`) relaying via ElasticEmail, with honeypot + rate limiting |
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

## Conventions

- Every change lands through a pull request and an AI code-review loop; merges happen only on a clean review of the branch head.
- Blog content follows the standards in [SEO-PLAN.md](SEO-PLAN.md) (keyword research, page standards) and each article ships with Article + FAQPage structured data.
- Conversion tracking is documented in [TRACKING.md](TRACKING.md) — three events, no personal data in any of them.

## Privacy

The contact form ships with an Israeli Privacy Protection Law (Amendment 13) disclosure. Analytics run under Google Consent Mode v2: all storage stays denied until the visitor opts in via the consent banner — before that, GA4 receives only cookieless, unidentified pings (see [TRACKING.md](TRACKING.md)). Form submissions are relayed by ElasticEmail; the API key lives in a Vercel environment variable, never in this repo.

---

© Ben Kalsky. Code is public for transparency; content, branding and licensed fonts are not for reuse.

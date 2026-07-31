# benkalsky.co.il

Personal landing page for Ben Kalsky — co-founder & CTO at [Digitizer](https://www.digitizer.co.il).

Static site served by GitHub Pages. No build step — edit `index.html` and push.

The contact form posts to a Vercel function (`contact-api/`, project `benkalsky-contact`) that relays submissions via Resend.

**TODO (email):** verify `benkalsky.co.il` as a sending domain in Resend, then change `FROM_ADDRESS` in `contact-api/api/contact.js` from `forms@quoty.co.il` to `forms@benkalsky.co.il` and redeploy (`vercel deploy --prod` from `contact-api/`).

Fonts: Greycliff Hebrew CF is self-hosted under `fonts/` (licensed; same family as digitizer.co.il).

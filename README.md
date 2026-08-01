# benkalsky.co.il

Personal landing page for Ben Kalsky — co-founder & CTO at [Digitizer](https://www.digitizer.co.il).

Static site served by GitHub Pages. No build step — edit `index.html` and push.

The contact form posts to a Vercel function (`contact-api/`, project `benkalsky-contact`) that relays submissions via ElasticEmail (sender: hello@benkalsky.co.il, key in Vercel env ELASTIC_EMAIL_API_KEY).


Fonts: Greycliff Hebrew CF is self-hosted under `fonts/` (licensed; same family as digitizer.co.il).

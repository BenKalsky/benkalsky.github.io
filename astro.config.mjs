import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.benkalsky.co.il',
  output: 'static',
  integrations: [
    sitemap({
      // The homepage is a verbatim static file in public/, invisible to
      // Astro's route collection — include it explicitly.
      customPages: ['https://www.benkalsky.co.il/'],
      // /thank-you/ carries noindex and is reachable only after the form is
      // accepted. Listing it in the sitemap would both contradict the meta
      // tag and invite Google to crawl a page whose whole value is that only
      // people who submitted the form ever see it.
      filter: (page) => !page.includes('/thank-you/'),
    }),
  ],
  build: {
    format: 'directory',
  },
});

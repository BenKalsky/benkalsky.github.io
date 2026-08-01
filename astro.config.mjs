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
    }),
  ],
  build: {
    format: 'directory',
  },
});

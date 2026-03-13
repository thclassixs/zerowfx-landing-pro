// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
    site: 'https://zerowfx.com',
    output: 'static', // Explicitly generate static HTML (SSG) — full HTML for crawlers
    trailingSlash: 'never', // Consistent URLs for canonical tags
    compressHTML: true, // Minify HTML output for faster crawling
    integrations: [
        sitemap({
            filter: (page) => !page.includes('/admin'),
            // When you add /news in the future, it will be auto-included
        }),
    ],
    server: {
        host: '0.0.0.0',
    },
});

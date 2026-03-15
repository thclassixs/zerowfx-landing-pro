// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
    site: 'https://zerowfx.com',
    output: 'server', // Default static, individual pages opt-in to SSR via prerender=false
    adapter: node({ mode: 'standalone' }), // Exports handler for Express integration, not its own server
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

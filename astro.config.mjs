// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
    site: 'https://zerowfx.com',
    integrations: [sitemap()],
    server: {
        host: '0.0.0.0',
    },
});

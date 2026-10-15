import { defineConfig } from 'astro/config';

// Static site. No inline styles or scripts are emitted, so the page can run under a script-src 'self' policy.
export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
});

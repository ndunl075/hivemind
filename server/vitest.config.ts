import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Test-only values. Real secrets are set with `wrangler secret put` and never committed.
        bindings: { ADMIN_TOKEN: 'test-admin-token', TOKEN_SECRET: 'test-token-secret' },
      },
    }),
  ],
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});

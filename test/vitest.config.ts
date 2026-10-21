import { defineConfig } from 'vitest/config';

// End-to-end and smoke tests. Run with --dir test/e2e or --dir test/smoke.
export default defineConfig({
  test: {
    include: ['**/*.test.{ts,mjs}'],
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});

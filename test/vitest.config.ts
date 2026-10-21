import { defineConfig } from 'vitest/config';

// End-to-end and smoke tests. Run with --dir test/e2e or --dir test/smoke.
// Files run one at a time: they share one wrangler dev on port 8788 (and the hook has a 1.5 s network budget).
export default defineConfig({
  test: {
    include: ['**/*.test.{ts,mjs}'],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

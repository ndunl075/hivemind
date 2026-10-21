import { defineConfig } from 'vitest/config';

// Node tests: shared/ and cli/. Server, dashboard and test/ have their own configs. Server and dashboard have their own configs.
export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'cli/**/*.test.mjs'],
    passWithNoTests: true,
  },
});

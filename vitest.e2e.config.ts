import { defineConfig } from 'vitest/config';

/** End-to-end: `pnpm e2e`. One app, one database, scenarios run in order in a real browser. */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    globalSetup: ['tests/e2e/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: 'forks',
    reporters: ['verbose'],
  },
});

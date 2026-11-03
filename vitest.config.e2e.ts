import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

/**
 * End-to-end tests run the real application against a real PostgreSQL
 * database given by TEST_DATABASE_URL. The database is TRUNCATED before each
 * test file — never point it at a database that holds real data.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), swc.vite({ module: { type: 'es6' } })],
  test: {
    globals:     true,
    root:        './',
    include:     ['test/**/*.e2e-spec.ts'],
    setupFiles:  ['test/setup-env.ts'],
    // `npm run docs:responses` records every JSON response's schema (see test/helpers.ts).
    globalSetup: process.env.RECORD_API_RESPONSES ? ['test/support/record-responses.ts'] : [],
    // Test files share one database, so they run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

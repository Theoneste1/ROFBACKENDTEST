import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

export default defineConfig({
  // SWC (not esbuild) so decorator metadata is emitted — NestJS dependency
  // injection relies on it. Path aliases come from tsconfig.json.
  plugins: [tsconfigPaths(), swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include:  ['src/**/*.ts'],
      exclude:  ['src/generated/**', 'src/**/*.spec.ts', 'src/**/*.module.ts', 'src/**/dto/**', 'src/main.ts'],
    },
  },
});

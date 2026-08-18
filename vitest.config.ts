import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/cli/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
  resolve: {
    alias: {
      // The dashboard uses Next's `@/*` path alias. Mirrored here so its route
      // handlers can be imported and tested directly.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
});

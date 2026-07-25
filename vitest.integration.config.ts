import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60000,   // embedding + LanceDB build can take a few seconds
    env: {
      // Serial Pass-1 extraction by default — see the note in vitest.config.ts
      // (change: optimize-parallel-extraction-pool).
      OPENLORE_NO_WORKERS: '1',
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});

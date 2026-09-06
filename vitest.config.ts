import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'examples/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', 'node_modules/**'],
    // A meaningful part of this suite builds REAL fixtures — git repositories,
    // SQLite edge stores, tree-sitter parses — because that is exactly what the
    // code under test reads. Process spawn alone costs ~150ms per `git` call on
    // some machines (macOS with the Xcode CLT shim), so a fixture that creates a
    // repo with three commits and two branches spends seconds before the first
    // assertion. Vitest's 5s default was tuned for pure unit tests and made those
    // suites pass only on fast hardware; under a full parallel run they timed out
    // and read as logic failures. 30s is chosen to be comfortably above the real
    // work while still catching a genuine hang.
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Keep the suite on the serial Pass-1 extraction lane by default
      // (change: optimize-parallel-extraction-pool): spawning real worker threads under
      // vitest would add seconds per multi-file build for zero coverage value. The pool
      // itself is covered deliberately — by a stub-worker lane for ordering/failure
      // semantics, and by one test that clears this flag to exercise real threads.
      OPENLORE_NO_WORKERS: '1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '*.config.*',
        // Infrastructure with no testable business logic
        'src/utils/logger.ts',   // log sink, no branching logic
        'src/utils/shutdown.ts', // signal handlers
        'src/utils/prompts.ts',  // @inquirer/prompts UI wiring
        // CLI entry points (integration-tested only)
        'src/cli/**',
        // Viewer React code (frontend, separate test stack)
        'src/viewer/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});

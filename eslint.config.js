import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // @eslint/js 10 promoted two rules into `recommended`. Both flag real hygiene
    // issues, and both are off HERE ONLY so that adopting them is its own reviewed
    // change rather than 48 edits across 31 files riding along with a version bump.
    //
    //   preserve-caught-error  — 12 sites / 7 files. Wants `{ cause }` when rethrowing
    //                            from a catch. Genuinely worth adopting: it preserves
    //                            the diagnostic chain.
    //   no-useless-assignment  — 36 sites / 24 files. Mostly defensive initializers
    //                            (`let x = []` where every branch reassigns) and dead
    //                            stores. Sampled several; none indicated a bug.
    //
    // Turning these on is a code change, not a config change. Remove these two lines
    // in the PR that does the fixes.
    rules: {
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
  {
    files: ['src/viewer/**/*.jsx', 'src/viewer/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'examples/**', '*.config.js', '*.config.ts', 'src/core/scip/fixtures/**', 'src/core/analyzer/iac/fixtures/**'],
  }
);

/**
 * Lint config for the dashboard.
 *
 * `pnpm run lint` was in CI and in this package's scripts, but no ESLint
 * configuration existed anywhere in the repo — so the step could only ever
 * fail. It went unnoticed because the typecheck step ran first and failed
 * earlier, on an unrelated problem.
 *
 * The rule set is deliberately small. TypeScript already runs in strict mode
 * and catches the whole class of errors a maximalist lint config would
 * duplicate; what is left here is the things the compiler cannot see —
 * hook ordering, unsafe casts, and fast-refresh boundaries.
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'coverage', 'node_modules', '*.cjs', 'vite.config.ts'],
  rules: {
    // A component file that also exports a helper breaks fast refresh, which
    // is a development-experience bug rather than a correctness one — warn.
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

    // The compiler's own `noUnusedLocals` does not understand the convention
    // that a leading underscore means "deliberately unused", so it is set here
    // instead of duplicating the check.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],

    // This is a compliance dashboard: an `any` is how a run status or a
    // signature verification result silently becomes unchecked.
    '@typescript-eslint/no-explicit-any': 'error',

    // Rules the TypeScript compiler already enforces, switched off rather than
    // run twice — a second opinion on the same question only produces
    // duplicate diagnostics.
    'no-unused-vars': 'off',
    'no-undef': 'off',
  },
};

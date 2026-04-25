// eslint.config.js — flat config (ESLint v9+).
//
// Scope is intentionally narrow: only the react-hooks plugin is wired
// up. We're not trying to enforce style or unused-vars across the whole
// codebase — that's what TypeScript + tsc -b is for. The single job of
// this config is to fail the build when someone introduces a Rules of
// Hooks violation (the class of bug that took planmatch.vercel.app to a
// blank white page in commit c5932ce).
//
// rules-of-hooks: error    — call hooks unconditionally, top of the
//                            component, in stable order. Catches the
//                            "useMemo after early return" pattern.
// exhaustive-deps: warn    — useEffect/useMemo dependency hygiene.
//                            Demoted to warn so existing intentional
//                            disables (Step5BenefitFilters, MedsPage,
//                            etc.) don't break the build; lint output
//                            still surfaces them in CI.
//
// Run: `npm run lint`. Wired into `npm run build` so Vercel fails the
// deploy on rules-of-hooks violations.

import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '_tmp/**',
      'scripts/**',
      'api/**',
      '**/*.d.ts',
      'supabase/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];

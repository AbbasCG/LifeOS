import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    rules: { 'react-refresh/only-export-components': ['error', { allowExportNames: ['useAuth', 'useLanguage', 'useTheme', 'useOverview', 'useStatusLabel'] }] },
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Playwright tests: fixtures call `use()`, which is not a React hook.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
])


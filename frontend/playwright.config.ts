import { defineConfig, devices } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Browser tests against the production build and a real Laravel server on an isolated, throwaway SQLite database seeded
 * with the demo account. No provider credentials or AI keys are set, and the tests block every request that leaves
 * 127.0.0.1, so they can never reach a real account.
 */
const root = dirname(fileURLToPath(import.meta.url))
const backend = resolve(root, '../backend')
process.env.E2E_DB ??= resolve(backend, 'storage/e2e.sqlite')
process.env.E2E_PASSWORD ??= `e2e-${randomBytes(12).toString('hex')}`
const isolated = {
  APP_ENV: 'testing', APP_DEBUG: 'false', APP_URL: 'http://127.0.0.1:8000', FRONTEND_URL: 'http://127.0.0.1:4173',
  DB_CONNECTION: 'sqlite', DB_DATABASE: process.env.E2E_DB, SESSION_DRIVER: 'database', CACHE_STORE: 'database', QUEUE_CONNECTION: 'sync',
  AI_PROVIDER: 'disabled', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', AI_REQUESTS_PER_MINUTE: '200',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '', TODOIST_CLIENT_ID: '', TODOIST_CLIENT_SECRET: '',
  LIFEOS_DEMO_ENABLED: 'true', LIFEOS_CALENDAR_WRITE: 'false', MAIL_MAILER: 'array',
}
process.env.E2E_BACKEND_ENV = JSON.stringify(isolated)

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One demo account with server-side preferences (language), so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    storageState: resolve(root, 'e2e/.auth/demo.json'),
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], reducedMotion: 'reduce', colorScheme: 'dark' } },
  ],
  webServer: [
    {
      // php -S directly: `artisan serve` does not pass most environment variables to its worker.
      // Laravel's router script resolves the public directory from the working directory.
      command: 'php -S 127.0.0.1:8000 ../vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php',
      cwd: resolve(backend, 'public'), url: 'http://127.0.0.1:8000/up', reuseExistingServer: false, timeout: 60_000,
      // The built-in server logs every request to stderr; failures surface through the tests and traces instead.
      env: isolated, stdout: 'ignore', stderr: 'ignore',
    },
    { command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1', cwd: root, url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 60_000 },
  ],
})

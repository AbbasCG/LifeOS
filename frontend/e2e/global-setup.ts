import { chromium, type FullConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Fresh isolated database, demo data, and one signed-in session shared by the tests. */
export default async function globalSetup(config: FullConfig) {
  const env = { ...process.env, ...JSON.parse(process.env.E2E_BACKEND_ENV!) }
  const backend = resolve(root, '../backend')
  rmSync(process.env.E2E_DB!, { force: true })
  writeFileSync(process.env.E2E_DB!, '')
  const artisan = (...args: string[]) => execFileSync('php', ['artisan', ...args, '--no-interaction'], { cwd: backend, env, stdio: 'pipe' })
  artisan('migrate:fresh', '--force')
  artisan('lifeos:demo', `--password=${process.env.E2E_PASSWORD}`)

  const state = resolve(root, 'e2e/.auth/demo.json')
  mkdirSync(dirname(state), { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ baseURL: config.projects[0].use.baseURL })
  await page.goto('/login')
  await page.fill('input[name=email]', 'demo@lifeos.local')
  await page.fill('input[name=password]', process.env.E2E_PASSWORD!)
  await page.click('form button.primary')
  await page.waitForURL('**/')
  await page.context().storageState({ path: state })
  await browser.close()
}

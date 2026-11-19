import { test, expect, zonedInstant } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * A brand-new person, start to finish: signing up in the browser starts the account in the browser's own zone (not UTC), and Quick Add
 * understands "Call the bank tomorrow at 10 for 30 minutes": the Tomorrow tile is shown selected, the task is saved as "Call the bank" with
 * its session tomorrow 10:00–10:30, and «Keep my exact text» saves the words as typed. A fresh account has an empty calendar, so these times
 * are free whatever the time of day. The browser is in Tokyo (no clock changes), never the server's zone.
 */
test.use({ storageState: { cookies: [], origins: [] }, timezoneId: 'Asia/Tokyo' })

const ZONE = 'Asia/Tokyo'
type Task = { id: number; title: string; due_at: string | null; estimated_minutes: number; schedule?: { starts_at: string; ends_at: string } | null }
async function call(page: Page, method: string, path: string) {
  return page.evaluate(async ([m, p]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p, { method: m, credentials: 'include', headers: { Accept: 'application/json', 'X-XSRF-TOKEN': token } })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path] as const)
}
const iso = (at: string) => new Date(at).toISOString().replace('.000Z', 'Z')
/** Tomorrow's date in Tokyo, 'YYYY-MM-DD' (Tokyo has no clock changes, so a day is 24 hours). */
const tokyoTomorrow = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(Date.now() + 24 * 3600 * 1000)

test('a new account gets the browser zone; Quick Add saves "Call the bank" tomorrow 10:00–10:30, or the exact text when asked', async ({ page, guard }, testInfo) => {
  guard.allowConsole(/status of 401/)   // the app asks who is signed in before there is anyone
  const email = `e2e-signup-${testInfo.project.name}-${Date.now()}@lifeos.local`

  // The app starts in Arabic for a browser it has never seen; this person chose English before signing up, and the account starts in it.
  await page.addInitScript(() => { if (!localStorage.getItem('lifeos-language')) localStorage.setItem('lifeos-language', 'en') })
  await page.goto('/register')
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible()
  await page.getByLabel('Name').fill('E2E New Person')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('a-long-e2e-password')
  await page.getByLabel('Confirm password').fill('a-long-e2e-password')
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/register'))
  await page.getByRole('button', { name: 'Create account' }).click()
  expect(JSON.parse((await sent).postData() ?? '{}')).toMatchObject({ email, timezone: ZONE, language: 'en' })
  await page.waitForURL(url => url.pathname === '/')

  const settings = (await call(page, 'GET', '/api/settings')).body
  expect(settings.timezone).toBe(ZONE)
  expect(settings.language).toBe('en')
  // A new account opens on the first-run setup (e2e/onboarding.spec.ts walks it); this person skips it to try Quick Add straight away.
  expect(settings.onboarding).toBe('pending')
  await page.getByRole('dialog', { name: 'Your basics' }).getByRole('button', { name: 'Skip setup' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const day = tokyoTomorrow()
  const open = async () => {
    await page.getByRole('button', { name: 'Quick add' }).filter({ visible: true }).first().click()
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await expect(sheet).toBeVisible()
    return sheet
  }
  const titled = async (title: string) => ((await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(title)}&per_page=10`)).body?.data as Task[] ?? []).filter(t => t.title === title)

  // The cleaned title, the Tomorrow tile, the session.
  let quick = await open()
  await quick.getByRole('textbox', { name: 'Task' }).fill('Call the bank tomorrow at 10 for 30 minutes')
  await expect(quick.getByText(/Understood:/)).toHaveText('Understood: Tomorrow 10:00–10:30 · “Call the bank”')
  const group = quick.getByRole('radiogroup', { name: 'When do you want to do it?' })
  await expect(group.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
  await expect(group.getByRole('radio', { name: 'Tomorrow' })).toHaveAccessibleDescription('from your text')
  await expect(group.getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'false')
  await expect(group.locator('[aria-checked="true"]')).toHaveCount(1)
  // Another tile does not quietly do nothing: it says how to choose another day.
  await group.getByRole('radio', { name: 'Today' }).click()
  await expect(quick.getByRole('status').filter({ hasText: 'Your text says tomorrow' })).toHaveText('Your text says tomorrow; remove it from the text to choose another day')
  await expect(group.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
  await quick.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByText('Added and scheduled: Tomorrow 10:00–10:30')).toBeVisible()
  await expect(quick).toBeHidden()
  const [saved] = await titled('Call the bank')
  expect(saved).toBeDefined()
  expect(saved.due_at).toBeNull(); expect(saved.estimated_minutes).toBe(30)
  expect(saved.schedule).toMatchObject({ starts_at: iso(zonedInstant(`${day}T10:00`, ZONE)), ends_at: iso(zonedInstant(`${day}T10:30`, ZONE)) })

  // «Keep my exact text» saves the words as typed (another free hour, so it is not a conflict with the first).
  quick = await open()
  const exact = 'Call the bank tomorrow at 11 for 30 minutes'
  await quick.getByRole('textbox', { name: 'Task' }).fill(exact)
  await quick.getByRole('checkbox', { name: 'Keep my exact text' }).check()
  await expect(quick.getByText(/Understood:/)).toHaveText('Understood: Tomorrow 11:00–11:30')
  await quick.getByRole('button', { name: 'Add task' }).click()
  await expect(quick).toBeHidden()
  const [kept] = await titled(exact)
  expect(kept).toBeDefined()
  expect(kept.schedule).toMatchObject({ starts_at: iso(zonedInstant(`${day}T11:00`, ZONE)) })
  // The choice is not remembered: the next Quick Add starts unticked.
  quick = await open()
  await quick.getByRole('textbox', { name: 'Task' }).fill('Pay rent tomorrow at 12')
  await expect(quick.getByRole('checkbox', { name: 'Keep my exact text' })).not.toBeChecked()
})

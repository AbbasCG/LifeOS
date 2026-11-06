import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The critical case, in a real browser against the real server: start a task of 25, 60 or 90 minutes. The timer must show the full length,
 * count down about one second per second (60:00 -> about 59:55 after five seconds), show no "complete" message, create no completed
 * session, and add nothing to the statistics until the person finishes, and then only the time that really passed.
 * Run on PostgreSQL with a non-UTC database time zone too: `E2E_PG=1` (database lifeos_e2e set to Europe/Amsterdam).
 */
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
  const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
}, [method, path, body] as const)

type S = { id: number; status: string; elapsed_seconds: number; duration_seconds: number; task_id: number | null; resumed_at: string | null; started_at: string | null; created_at: string; server_time: string }
const sessions = async (page: Page) => ((await api(page, 'GET', '/api/focus-sessions')).body as { data: S[] }).data
const focusMinutes = async (page: Page) => ((await api(page, 'GET', '/api/focus-sessions/insights?days=30')).body as { minutes: number }).minutes
const seconds = async (page: Page) => { const parts = (await page.locator('.dial-time').innerText()).split(':').map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1] }

async function clean(page: Page) {
  for (const s of await sessions(page)) if (s.status === 'running' || s.status === 'paused') await api(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })
}
test.beforeEach(async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.evaluate(() => localStorage.setItem('lifeos-language', 'en'))
  await clean(page)
})
test.afterEach(async ({ page }) => { await clean(page).catch(() => undefined) })

for (const planned of [25, 60, 90]) {
  test(`a ${planned}-minute task counts down from ${planned} minutes and completes nothing by itself`, async ({ page }) => {
    await page.goto('/tasks')
    const title = `Sixty ${planned} ${Date.now()}`
    const task = ((await api(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: planned })).body as { data: { id: number } }).data.id
    try {
      const baselineId = Math.max(0, ...(await sessions(page)).map(s => s.id))
      const minutesBefore = await focusMinutes(page)
      await page.reload()
      await page.getByRole('button', { name: new RegExp(`Focus on .*${title}`) }).first().click()
      await expect(page).toHaveURL(new RegExp(`/focus\\?task=${task}$`))
      const total = planned * 60
      await expect(page.locator('.dial-time')).toHaveText(planned === 90 ? '1:30:00' : `${planned}:00`)

      await page.locator('.focus-start').click()
      await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
      expect(await seconds(page), 'the full length is shown right after Start').toBeGreaterThanOrEqual(total - 3)
      await page.waitForTimeout(5000)
      const after5 = await seconds(page)
      const detail = `after 5 s the timer shows ${after5} s (planned ${total} s)\nserver record: ${JSON.stringify((await sessions(page)).find(s => s.id > baselineId))}`
      expect(after5, detail).toBeLessThanOrEqual(total - 4)
      expect(after5, detail).toBeGreaterThanOrEqual(total - 12)

      await expect(page.getByText(/Session complete|اكتملت الجلسة/)).toHaveCount(0)
      const added = (await sessions(page)).filter(s => s.id > baselineId)
      expect(added.map(s => s.status), 'one running session, no completed record').toEqual(['running'])
      expect(added[0].task_id).toBe(task)
      expect(await focusMinutes(page), 'nothing is counted in the statistics yet').toBe(minutesBefore)

      await page.getByRole('button', { name: /Finish & save/ }).click()
      await expect(page.locator('.focus-start')).toBeVisible()
      const done = (await sessions(page)).find(s => s.id > baselineId)!
      expect(done.status).toBe('completed')
      expect(done.elapsed_seconds, 'only the real time is saved').toBeLessThan(30)
      expect(await focusMinutes(page), 'not the planned minutes (the real few seconds may tip the rounded total by one)').toBeLessThanOrEqual(minutesBefore + 1)
      const t = ((await api(page, 'GET', `/api/tasks/${task}`)).body as { data: { status: string; actual_minutes: number } }).data
      expect(t.status).toBe('todo')
      expect(t.actual_minutes).toBeLessThanOrEqual(1)
    } finally { await api(page, 'DELETE', `/api/tasks/${task}`) }
  })
}

test('pause holds the time, resume continues, a refresh and a tab switch keep the real time', async ({ page }) => {
  await page.goto('/focus')
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: /Pause/ }).click()
  await expect(page.locator('.dial-status')).toHaveText(/Paused/)
  const held = await seconds(page)
  expect(held).toBeGreaterThan(24 * 60 + 40)
  await page.waitForTimeout(2500)
  expect(await seconds(page)).toBe(held)
  await page.getByRole('button', { name: /Resume/ }).click()
  await expect(page.locator('.dial-status')).not.toHaveText(/Paused/)
  await expect.poll(() => seconds(page), { timeout: 8000 }).toBeLessThan(held)

  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(1200)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(800)
  expect(await seconds(page)).toBeGreaterThan(24 * 60 + 30)
  await page.reload()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  expect(await seconds(page)).toBeGreaterThan(24 * 60 + 20)
  expect(await seconds(page)).toBeLessThan(held)
  await expect(page.getByText(/Session complete|ended while you were away/)).toHaveCount(0)
})

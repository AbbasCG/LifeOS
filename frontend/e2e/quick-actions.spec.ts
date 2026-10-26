import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}

async function stopFocus(page: Page) {
  const list = await call(page, 'GET', '/api/focus-sessions')
  for (const s of list?.data ?? list ?? []) if (s.status === 'running' || s.status === 'paused') await call(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })
}

/** The language preference reaches the browser after the first page load; wait for it before following a link. */
async function english(page: Page, setLanguage: (l: 'en' | 'ar') => Promise<void>) {
  await setLanguage('en')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
}

test('a habit is logged from a notification button and from the habit sheet, with undo', async ({ page, setLanguage }) => {
  await english(page, setLanguage)
  const habit = (await call(page, 'POST', '/api/habits', { title: `E2E stretch ${Date.now()}`, remind_time: '07:30' })).data
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  const loggedToday = async () => (((await call(page, 'GET', '/api/habits?per_page=100')).data.find((h: { id: number }) => h.id === habit.id)?.entries) ?? []).some((e: { date: string }) => e.date === today)
  try {
    // What the "Done" button on a habit reminder opens.
    await page.goto(`/?habit=${habit.id}&done=1`)
    await expect(page.getByText(`Logged “${habit.title}”.`)).toBeVisible()
    await expect(page).not.toHaveURL(/habit=/)
    expect(await loggedToday()).toBe(true)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByText('Undone.')).toBeVisible()
    expect(await loggedToday()).toBe(false)

    // The installed app's "Log a habit" shortcut.
    await page.goto('/?log=habits')
    const sheet = page.getByRole('dialog', { name: 'Log a habit' })
    await expect(sheet.getByText('Daily · 07:30').first()).toBeVisible()
    await sheet.getByRole('button', { name: `Log “${habit.title}”` }).click()
    await expect(sheet.getByRole('button', { name: `Undo “${habit.title}”` })).toHaveAttribute('aria-pressed', 'true')
    expect(await loggedToday()).toBe(true)
    await sheet.getByRole('button', { name: 'Close' }).click()
    await expect(sheet).toBeHidden()
  } finally {
    await call(page, 'DELETE', `/api/habits/${habit.id}`)
  }
})

test('focus and a break start in one tap from the shortcut and notification buttons', async ({ page, setLanguage, guard }) => {
  // Starting while a session runs is refused by the server (422) and explained to the user.
  guard.allowConsole(/status of 422/)
  await english(page, setLanguage)
  await stopFocus(page)
  try {
    await page.goto('/?focus=start')
    await expect(page).toHaveURL(/\/focus$/)
    await expect(page.locator('.focus-dial')).toBeVisible()
    let list = await call(page, 'GET', '/api/focus-sessions')
    expect((list?.data ?? list).find((s: { status: string }) => s.status === 'running')?.kind).toBe('focus')
    // A second tap while a session runs does not start another one.
    await page.goto('/?focus=break')
    await expect(page.getByText('A session is already running.')).toBeVisible()
    await stopFocus(page)
    await page.goto('/?focus=break')
    await expect(page).toHaveURL(/\/focus$/)
    list = await call(page, 'GET', '/api/focus-sessions')
    expect((list?.data ?? list).find((s: { status: string }) => s.status === 'running')?.kind).toBe('short_break')
  } finally {
    await stopFocus(page)
  }
})

test('notification settings say whether this browser shows buttons on notifications', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/settings/notifications')
  const buttons = await page.evaluate(() => typeof Notification !== 'undefined' && ((Notification as unknown as { maxActions?: number }).maxActions ?? 0) > 0)
  await expect(page.locator('.quick-support')).toContainText(buttons ? 'work in this browser' : 'doesn’t show buttons on notifications')
})

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * A task reminder's buttons (Done, In 1 hour, Tomorrow) are links the app performs when it opens. They are opened here
 * the way a tap on the notification would open them; the notification itself needs a real push service.
 */
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}

async function withTask<T>(page: Page, run: (task: { id: number; title: string; remind_at: string; due_at: string }) => Promise<T>) {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('lifeos-language', 'en'))   // a link opened on a fresh page reads this before the account's setting arrives
  const remind = new Date(Date.now() - 600_000).toISOString(), due = new Date(Date.now() + 2 * 86_400_000).toISOString()
  const made = await call(page, 'POST', '/api/tasks', { title: `E2E reminder ${Date.now()}`, status: 'todo', priority: 'high', remind_at: remind, due_at: due })
  const task = made.body.data as { id: number; title: string; remind_at: string; due_at: string }
  try { return await run(task) } finally { await call(page, 'DELETE', `/api/tasks/${task.id}`) }
}
const read = async (page: Page, id: number) => (await call(page, 'GET', `/api/tasks/${id}`)).body.data as { status: string; remind_at: string | null; due_at: string | null }

test('Done from a reminder completes the task, clears the link, and Undo reopens it', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await withTask(page, async task => {
    await page.goto(`/?task=${task.id}&done=1`)
    // The link acts after the app signs in and its first requests, on a one-request-at-a-time test server: allow for that.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 15_000 })
    expect((await read(page, task.id)).status).toBe('completed')
    await expect(page).toHaveURL(/\/$/)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await read(page, task.id)).status).toBe('todo')
  })
})

test('"In 1 hour" brings the reminder back an hour from now, and Undo restores the old one', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await withTask(page, async task => {
    await page.goto(`/?task=${task.id}&snooze=hour`)
    // The link acts after the app signs in and its first requests, on a one-request-at-a-time test server: allow for that.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 15_000 })
    const after = await read(page, task.id)
    const minutes = (Date.parse(after.remind_at!) - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(55); expect(minutes).toBeLessThan(65)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => Date.parse((await read(page, task.id)).remind_at!)).toBe(Date.parse(task.remind_at))
  })
})

test('"Tomorrow" moves the deadline to tomorrow, and a link to a task opens that task', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await withTask(page, async task => {
    const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
    const dayIn = (at: number | string) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone })
    await page.goto(`/?task=${task.id}&snooze=tomorrow`)
    // The link acts after the app signs in and its first requests, on a one-request-at-a-time test server: allow for that.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => dayIn((await read(page, task.id)).due_at!)).toBe(dayIn(Date.now() + 86_400_000))

    await page.goto(`/tasks?task=${task.id}`)
    const row = page.locator(`[data-task="${task.id}"]`)
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/expanded/)
    await expect(row.getByRole('group', { name: 'Move to' })).toBeVisible()
  })
})

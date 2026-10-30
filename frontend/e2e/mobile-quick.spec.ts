import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Fewer taps for what is done most (V30): moving or re-prioritising a task takes two taps from the list, and "Plan my day" is one tap from Today on a phone as well. */
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
const dayIn = (at: Date | string, zone: string) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone })
const clock = (at: string, zone: string) => new Date(at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', timeZone: zone })

test('a task moves to tomorrow and changes priority in two taps each, with Undo', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E quick ${Date.now()}`
  const inDays = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'high', due_at: inDays })
  expect(made.status).toBe(201)
  const id = made.body.data.id as number
  const read = async () => (await call(page, 'GET', `/api/tasks/${id}`)).body.data as { due_at: string | null; priority: string }
  try {
    await page.goto('/tasks')
    const row = page.locator('.task-item', { hasText: title })
    await expect(row).toBeVisible()

    // Move to tomorrow: tap the task (1), tap "Tomorrow" (2). 17:00 on the account's tomorrow.
    await row.locator('.task-body').click()
    await row.getByRole('button', { name: 'Tomorrow' }).click()
    await expect.poll(async () => (await read()).due_at ? dayIn((await read()).due_at!, zone) : null).toBe(dayIn(new Date(Date.now() + 86_400_000), zone))
    expect(clock((await read()).due_at!, zone)).toBe('05:00 PM')

    // Undo puts the date back.
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await read()).due_at?.slice(0, 16)).toBe(inDays.slice(0, 16))

    // Priority: tap the task (already open), tap "Urgent".
    await row.getByRole('radio', { name: 'Urgent' }).click()
    await expect.poll(async () => (await read()).priority).toBe('urgent')
    await expect(row.getByRole('radio', { name: 'Urgent' })).toHaveAttribute('aria-checked', 'true')

    // "No date" clears it.
    await row.getByRole('button', { name: 'No date' }).click()
    await expect.poll(async () => (await read()).due_at).toBeNull()
  } finally {
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
})

test('Plan my day is one tap from Today, on a phone too', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const plan = page.getByRole('link', { name: /Plan my day/ }).first()
  await expect(plan).toBeVisible()
  await plan.click()
  await expect(page).toHaveURL(/\/today\/plan/)
})

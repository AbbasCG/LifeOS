import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}

test('changes made offline wait on the device, are sent only on request, and conflicts are the user’s call', async ({ page, context, setLanguage, guard }) => {
  // Requests that fail while offline are expected here.
  guard.allowConsole(/Failed to load resource|ERR_INTERNET_DISCONNECTED/)
  await setLanguage('en')
  const stamp = Date.now(), due = new Date(Date.now() + 2 * 3600 * 1000).toISOString()
  const one = (await call(page, 'POST', '/api/tasks', { title: `E2E offline one ${stamp}`, status: 'todo', priority: 'high', due_at: due })).data
  const two = (await call(page, 'POST', '/api/tasks', { title: `E2E offline two ${stamp}`, status: 'todo', priority: 'high', due_at: due })).data
  const added = `E2E offline new ${stamp}`
  try {
    await page.goto('/tasks')
    await expect(page.locator('.task-item', { hasText: one.title })).toBeVisible()

    await context.setOffline(true)
    await expect(page.getByRole('status').filter({ hasText: 'You’re offline' })).toBeVisible()
    await page.getByRole('button', { name: 'Quick add' }).filter({ visible: true }).first().click()
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await sheet.getByRole('textbox', { name: 'Task' }).fill(added)
    await sheet.getByRole('button', { name: /Add task/ }).click()
    await expect(page.getByText('Saved on this device. Send it from “Waiting to sync” when you’re online.').first()).toBeVisible()
    await page.locator('.task-item', { hasText: one.title }).getByRole('button', { name: `Complete “${one.title}”` }).click()
    await page.locator('.task-item', { hasText: two.title }).getByRole('button', { name: `Complete “${two.title}”` }).click()
    await expect(page.getByRole('button', { name: /3 waiting to sync/ })).toBeVisible()

    // Back online: a suggestion to review; nothing is sent by itself.
    await context.setOffline(false)
    await expect(page.getByText('Back online. 3 change(s) waiting to sync.')).toBeVisible()
    expect((await call(page, 'GET', `/api/tasks/${one.id}`)).data.status).toBe('todo')
    // Meanwhile "another device" edits task two.
    await page.waitForTimeout(1100)
    await call(page, 'PATCH', `/api/tasks/${two.id}`, { priority: 'low' })

    await page.getByRole('button', { name: /3 waiting to sync/ }).click()
    const sync = page.getByRole('dialog', { name: 'Waiting to sync' })
    await sync.getByRole('button', { name: /Send all/ }).click()
    await expect(page.getByText('2 sent. 1 need(s) your decision.')).toBeVisible()
    expect((await call(page, 'GET', `/api/tasks/${one.id}`)).data.status).toBe('completed')
    expect((await call(page, 'GET', `/api/tasks/${two.id}`)).data.status).toBe('todo')
    const created = (await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(added)}`)).data
    expect(created).toHaveLength(1)

    await expect(sync.getByText('Changed on another device since then.')).toBeVisible()
    await sync.getByRole('button', { name: 'Complete anyway' }).click()
    await expect(sync.getByText('Everything is in sync.')).toBeVisible()
    expect((await call(page, 'GET', `/api/tasks/${two.id}`)).data.status).toBe('completed')
    await expect(page.getByRole('button', { name: /waiting to sync/ })).toHaveCount(0)
  } finally {
    await context.setOffline(false)
    for (const t of (await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(`E2E offline`)}&per_page=50&due=`))?.data ?? []) if (String(t.title).includes(String(stamp))) await call(page, 'DELETE', `/api/tasks/${t.id}`)
  }
})
